// Discord bot main file (discord.js v14/v15+ compatible, uses "import")
// Author: GPT-4R Large Scale Example Implementation

import { Client, GatewayIntentBits, Partials, Routes, REST, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType, InteractionType } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { config } from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

config(); // Load env vars

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const DATA_DIR = '/data/';

const DB_PATH = path.join(DATA_DIR, 'bot.sqlite');

let db; // global sqlite instance

async function ensureDataDir() {
    try {
        await fs.access(DATA_DIR);
    } catch (e) {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }
}

// SLASH COMMAND DEFINITIONS
const commands = [
    {
        name: 'ping',
        description: '🏓 Check the bot latency!',
    },
    {
        name: 'purge',
        description: '🧹 Bulk delete recent messages.',
        options: [
            {
                type: 4,
                name: 'count',
                description: 'Number of messages to delete (max 50)',
                required: true,
                min_value: 2,
                max_value: 50,
            }
        ],
        default_member_permissions: PermissionFlagsBits.ManageMessages.toString(),
    },
    {
        name: 'userinfo',
        description: '👤 Get your info or someone else\'s.',
        options: [
            {
                type: 6,
                name: 'user',
                description: 'Which user?',
                required: false
            }
        ]
    },
    {
        name: 'quote',
        description: '📦 Save or recall memorable messages!',
        options: [
            {
                type: 3,
                name: 'action',
                description: 'Add/View/Remove quotes',
                required: true,
                choices: [
                    { name: 'add', value: 'add' },
                    { name: 'list', value: 'list' },
                    { name: 'remove', value: 'remove' }
                ]
            },
            {
                type: 3,
                name: 'text',
                description: 'Text to add as quote or ID to remove',
                required: false
            }
        ]
    },
    {
        name: '8ball',
        description: '🎱 Magic 8-ball answers your question!',
        options: [
            {
                type: 3,
                name: 'question',
                description: 'Ask anything...',
                required: true
            }
        ]
    },
    {
        name: 'suggest',
        description: '💡 Suggest something!',
    },
    {
        name: 'reminder',
        description: '⏰ Set a reminder!',
        options: [
            {
                type: 3,
                name: 'time',
                description: 'After how long? e.g. 10m, 2h, 1d',
                required: true
            },
            {
                type: 3,
                name: 'reason',
                description: 'Reminder text',
                required: false
            }
        ]
    },
    {
        name: 'myreminders',
        description: '📋 View or delete your active reminders'
    }
];

// Emoji answers for 8ball:
const EIGHTBALL_ANSWERS = [
    'It is certain.', 'Yes.', 'No.', 'Very doubtful.', 'My sources say no.',
    'Definitely.', 'Probably.', 'Ask again later.', 'Cannot predict now.',
    'Yes – definitely.', 'Don’t count on it.', 'Most likely.',
    'Outlook good.', 'Yes, in due time.', 'Absolutely yes.', 'No, sorry.'
];

// SETUP CLIENT
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.User
    ]
});

// Utils
function safeChannel(interaction) {
    // Allow only designated channel or DMs
    if (interaction.channel && interaction.channel.type === ChannelType.DM) return true;
    return interaction.channelId == CHANNEL_ID;
}

// Register slash commands
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(
        Routes.applicationGuildCommands((await client.application.fetch()).id, GUILD_ID),
        { body: commands }
    );
}

// Database setup/migration
async function setupDatabase() {
    db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });
    // Quotes, Suggestions might exists already. Check and migrate if necessary.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user TEXT NOT NULL,
            quote TEXT NOT NULL,
            date TEXT NOT NULL
        );
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS suggestions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user TEXT NOT NULL,
            suggestion TEXT NOT NULL,
            date TEXT NOT NULL,
            status TEXT NOT NULL
        );
    `);
}

// UX: Helper: Ephemeral error/success
async function replySafe(interaction, opts) {
    // Only ephemeral for slash & modals
    try {
        if (interaction.deferred || interaction.replied) {
            return interaction.followUp({ ...opts, ephemeral: true });
        } else {
            return interaction.reply({ ...opts, ephemeral: true });
        }
    } catch (e) {
        // fallback
    }
}

// SUGGESTION SYSTEM: Modal input + admin approve/deny
async function handleSuggest(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('suggestModal')
        .setTitle('💡 Suggestion');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('suggest_input')
                .setLabel('What do you suggest?')
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(4)
                .setMaxLength(600)
                .setRequired(true)
        )
    );
    await interaction.showModal(modal);
}
async function handleModalSubmit(interaction) {
    if (interaction.customId === 'suggestModal') {
        const value = interaction.fields.getTextInputValue('suggest_input');
        await db.run(
            `INSERT INTO suggestions(user, suggestion, date, status) VALUES (?, ?, ?, ?)`,
            interaction.user.id, value, new Date().toISOString(), 'pending'
        );
        await replySafe(interaction, {
            content: '✅ Thank you for your suggestion! An admin will review it soon.'
        });
        // Optionally DM admin, or log.
    }
}

// ADMIN: Approve/deny suggestions (via button)
async function showSuggestions(interaction) {
    // Only allow in allowed channel.
    if (!safeChannel(interaction)) return;

    const pending = await db.all(
        `SELECT id, user, suggestion, date FROM suggestions WHERE status = 'pending' ORDER BY date ASC LIMIT 10`
    );
    if (!pending.length) return replySafe(interaction, { content: 'No pending suggestions.' });

    for (const sug of pending) {
        const embed = new EmbedBuilder()
            .setTitle('New suggestion')
            .setDescription(sug.suggestion)
            .addFields(
                { name: 'User', value: `<@${sug.user}>`, inline: true },
                { name: 'Date', value: new Date(sug.date).toLocaleString(), inline: true }
            )
            .setFooter({ text: 'Use the buttons to approve or deny.' });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`sug-approve-${sug.id}`)
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`sug-deny-${sug.id}`)
                .setLabel('Deny')
                .setStyle(ButtonStyle.Danger)
        );
        await interaction.channel.send({ embeds: [embed], components: [row] });
    }
    await replySafe(interaction, { content: 'Above are pending suggestions for review.' });
}
async function handleSuggestionButton(interaction) {
    const match = interaction.customId.match(/sug-(approve|deny)-(\d+)/);
    if (!match) return;
    const [, action, id] = match;
    const sug = await db.get(`SELECT * FROM suggestions WHERE id=?`, id);
    if (!sug) {
        return replySafe(interaction, { content: 'Suggestion not found.' });
    }
    await db.run(`UPDATE suggestions SET status=? WHERE id=?`, action === 'approve' ? 'approved' : 'denied', id);
    await interaction.update({
        content: `Suggestion marked as **${action === 'approve' ? 'APPROVED' : 'DENIED'}**.`,
        components: [],
        embeds: interaction.message.embeds
    });
    try {
        const userObj = await client.users.fetch(sug.user);
        if (userObj) {
            await userObj.send(`Your suggestion was **${action === 'approve' ? 'approved ✅' : 'denied ❌'}**:\n> ${sug.suggestion}`);
        }
    } catch {}
}

// QUOTE SYSTEM
async function handleQuote(interaction, action, text) {
    if (action === 'add') {
        if (!text || text.length < 5) return replySafe(interaction, { content: 'Please provide a longer quote!' });
        await db.run(
            `INSERT INTO quotes(user, quote, date) VALUES (?, ?, ?)`,
            interaction.user.id, text, new Date().toISOString()
        );
        return replySafe(interaction, { content: '✅ Quote saved!' });
    } else if (action === 'list') {
        const quotes = await db.all(`SELECT id, quote, user, date FROM quotes ORDER BY id DESC LIMIT 5`);
        if (!quotes.length) return replySafe(interaction, { content: 'No quotes yet!' });
        const fields = quotes.map(q => ({
            name: `#${q.id} ${new Date(q.date).toLocaleString()}`,
            value: `_${q.quote}_\n— <@${q.user}>`
        }));
        return replySafe(interaction, {
            embeds: [new EmbedBuilder().setTitle('Recent Quotes').setFields(fields)]
        });
    } else if (action === 'remove') {
        if (!text || isNaN(Number(text))) return replySafe(interaction, { content: 'Specify the quote ID to remove.' });
        const quote = await db.get(`SELECT * FROM quotes WHERE id=?`, text);
        if (!quote) return replySafe(interaction, { content: 'Quote not found.' });
        if (quote.user !== interaction.user.id) return replySafe(interaction, { content: 'Only the author can remove this quote.' });
        await db.run(`DELETE FROM quotes WHERE id=?`, text);
        return replySafe(interaction, { content: '🗑️ Quote removed.' });
    }
}

// MODERATION: Purge
async function handlePurge(interaction, count) {
    const fetch = await interaction.channel.messages.fetch({ limit: Math.min(count,50) });
    // exclude pinned
    const toDelete = fetch.filter(msg => !msg.pinned).first(count);
    await interaction.channel.bulkDelete(toDelete, true);
    await replySafe(interaction, { content: `🧹 Deleted ${toDelete.length} messages.` });
}

async function handle8ball(interaction, question) {
    // just fun
    if (!question) return replySafe(interaction, { content: 'Ask a question.' });
    const answer = EIGHTBALL_ANSWERS[Math.floor(Math.random() * EIGHTBALL_ANSWERS.length)];
    await replySafe(interaction, {
        embeds: [
            new EmbedBuilder()
                .setTitle(`🎱 ${question}`)
                .setDescription(answer)
                .setFooter({ text: 'The Magic 8 Ball has spoken.' })
        ]
    });
}

// User Info
async function handleUserInfo(interaction, user) {
    const member = user || interaction.member;
    const embed = new EmbedBuilder()
        .setTitle(`User info for ${member.user.username}`)
        .addFields(
            { name: 'Username', value: member.user.tag, inline: true },
            { name: 'ID', value: member.user.id, inline: true },
            { name: 'Joined', value: new Date(member.joinedTimestamp || member.user.createdTimestamp).toLocaleString(), inline: false },
        )
        .setThumbnail(member.user.displayAvatarURL());
    await replySafe(interaction, { embeds: [embed] });
}

// UX: Onboarding DM prompt
client.on('guildMemberAdd', async (member) => {
    if (member.user.bot) return;
    try {
        await member.send(
            `👋 Welcome to the server!
- Use **/suggest** to suggest improvements!
- Use **/quote** to save funny messages or memories!
- Use **/userinfo** for your info.
- Everything fun is in <#${CHANNEL_ID}>`
        );
    } catch {}
});

// COMMAND HANDLER
client.on('interactionCreate', async (interaction) => {
    // Only for allowed channel or DMs
    if (interaction.isChatInputCommand()) {
        if (!safeChannel(interaction)) return replySafe(interaction, { content: 'This bot only works in the allowed channel.' });
        switch (interaction.commandName) {
            case 'ping':
                await replySafe(interaction, { content: `🏓 Pong! Latency: ${client.ws.ping}ms` });
                break;
            case 'purge':
                await handlePurge(interaction, interaction.options.getInteger('count'));
                break;
            case 'userinfo':
                await handleUserInfo(interaction, interaction.options.getUser('user')
                    ? await interaction.guild.members.fetch(interaction.options.getUser('user').id)
                    : interaction.member
                );
                break;
            case 'quote':
                await handleQuote(interaction, interaction.options.getString('action'), interaction.options.getString('text'));
                break;
            case '8ball':
                await handle8ball(interaction, interaction.options.getString('question'));
                break;
            case 'suggest':
                await handleSuggest(interaction);
                break;
        }
    } else if (interaction.isButton()) {
        // Only suggestion approves
        if (!safeChannel(interaction)) return;
        await handleSuggestionButton(interaction);
    } else if (interaction.type === InteractionType.ModalSubmit) {
        await handleModalSubmit(interaction);
    }
});

// MOD TOOLS: Add context menu: Right click message = Quote
client.on('messageCreate', async (msg) => {
    // Ignore bots and not in allowed channel
    if (msg.author.bot) return;
    if (msg.channel.type !== ChannelType.DM && msg.channelId !== CHANNEL_ID) return;
    // Content moderation: very simple forbidden word filter
    const forbidden = ["badword1", "badword2"]; // TODO: config
    if (forbidden.some(w => msg.content.toLowerCase().includes(w))) {
        try { await msg.delete(); } catch {}
        try { await msg.author.send('🚫 Please mind your language.'); } catch {}
        return;
    }

    // Quick quote: "quote: text"
    if (msg.content.toLowerCase().startsWith('quote:')) {
        await db.run(
            `INSERT INTO quotes(user, quote, date) VALUES (?, ?, ?)`,
            msg.author.id, msg.content.slice(6).trim(), new Date().toISOString()
        );
        await msg.reply('✅ Quoted!');
    }
    // Suggest via DM: "suggest: text"
    if (msg.channel.type === ChannelType.DM && msg.content.toLowerCase().startsWith('suggest:')) {
        await db.run(
            `INSERT INTO suggestions(user, suggestion, date, status) VALUES (?, ?, ?, ?)`,
            msg.author.id, msg.content.slice(8).trim(), new Date().toISOString(), 'pending'
        );
        await msg.reply('✅ Suggestion received! We will review it soon.');
    }
});

// Register context menu for "Show Suggestions" for mods
async function registerAdminContextMenu() {
    // Button function for admin to list pending suggestions
    const adminCmd = [
        {
            name: "Show Suggestions",
            type: 2, // MESSAGE context menu
            default_member_permissions: PermissionFlagsBits.ManageMessages.toString(),
        }
    ];
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(
        Routes.applicationGuildCommands((await client.application.fetch()).id, GUILD_ID),
        { body: adminCmd }
    );
    // Route it
    client.on('interactionCreate', async (interaction) => {
        if (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Show Suggestions') {
            if (!safeChannel(interaction)) return replySafe(interaction, { content: 'This bot only works in the allowed channel.' });
            await showSuggestions(interaction);
        }
    });
}

await ensureDataDir();
await setupDatabase();
client.once('ready', async () => {
    console.log(`[READY] Logged in as ${client.user.tag}`);
    await registerCommands();
    await registerAdminContextMenu();
    client.user.setActivity('/suggest | /quote | /purge');
});

await client.login(TOKEN);
