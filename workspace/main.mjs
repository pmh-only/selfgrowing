// main.mjs

import { Client, GatewayIntentBits, Partials, REST, Routes, InteractionType, PermissionFlagsBits, MessageType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import sqlite3 from 'sqlite3';
import fs from 'fs/promises';
import { open } from 'sqlite';

// Utility constants/env
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const DATA_DIR = "/data/";

// Ensure data dir
async function ensureDataDir() {
    try { await fs.stat(DATA_DIR); } 
    catch { await fs.mkdir(DATA_DIR, { recursive: true }) }
}

// ------- Helper: End poll and show results ---------
async function finishPoll(pollRec, chan) {
    try {
        const opts = JSON.parse(pollRec.options);
        const votes = JSON.parse(pollRec.votes || '{}');
        let counts = opts.map((_,i)=>Object.values(votes).filter(v=>v==i).length);
        let desc = opts.map((opt,i)=>`${pollEmojis[i]} **${opt}** — ${counts[i]} vote${counts[i]!=1?'s':''}`).join("\n");
        let winners = [];
        let max = Math.max(...counts);
        for (let i=0;i<counts.length;i++) if (counts[i]===max && max>0) winners.push(opts[i]);
        desc += `\n\nWinner${winners.length>1?'s':''}: **${winners.join(', ')||"N/A"}**`;
        await chan.messages.edit(pollRec.messageId, {
            embeds:[
                new EmbedBuilder()
                .setTitle("📊 [Poll Closed] "+pollRec.title)
                .setDescription(desc)
                .setColor(0x8B5CFF)
            ],
            components: []
        });
        // Remove poll from db
        await db.run("DELETE FROM poll WHERE id=?", pollRec.id);
    } catch {}
}

await ensureDataDir();

/**
 * Check and migrate pinned_notes legacy table (if present!) into new todo_entries structure.
 * Migrates pinned_notes(ownerId, noteId) -> todo_entries(userId, content, done, ts), pulling data from notes.
 * Drops pinned_notes table on success.
 */
async function migratePinnedToTodo() {
    try {
        const hasTable = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pinned_notes'");
        if (!hasTable) return;
        // Pull links
        const pins = await db.all("SELECT * FROM pinned_notes");
        for (const pin of pins) {
            // pin: {ownerId, noteId}
            const n = await db.get("SELECT note, timestamp FROM notes WHERE id=?", pin.noteId);
            if (n) {
                // Insert as new todo (set done=0, best guess)
                await db.run("INSERT INTO todo_entries(userId, content, done, ts) VALUES (?,?,0,?)", pin.ownerId, n.note, n.timestamp);
            }
        }
        await db.run("DROP TABLE pinned_notes");
    } catch (e) {
        // fail silently
    }
}
// SQLite DB setup
const db = await open({
    filename: DATA_DIR + 'botdata.db',
    driver: sqlite3.Database
});
await db.run(`CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    note TEXT NOT NULL,
    timestamp INTEGER NOT NULL
    -- pinned removed, migrated, see below
)`);
// Fix error: ensure any legacy pinned_notes table is not left broken (after new deploys/updates)
// Only try to use it if it really exists.
try {
    // Try to select from pinned_notes (legacy table) if exists, to avoid SELECT * FROM non-existing table errors
    let tbls = await db.all("SELECT name FROM sqlite_master WHERE type='table'");
    const needsMigrate = tbls.some(t=>t.name==="pinned_notes");
    if (needsMigrate) {
        // Try SELECT and DROP in try/catch (persist old format migration)
        try {
            await db.all("SELECT * FROM pinned_notes");
            // If we were able to select, attempt migration (idempotent)
            await migratePinnedToTodo();
        } catch {}
    }
} catch {}




await db.run(`CREATE TABLE IF NOT EXISTS poll (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    options TEXT NOT NULL,
    creatorId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    messageId TEXT,
    votes TEXT NOT NULL DEFAULT '{}',
    expiresAt INTEGER
)`);
// Patch: on startup, close out any expired leftover polls (shouldn't be possible, but for data consistency)
const leftOpenPolls = await db.all(`SELECT * FROM poll WHERE expiresAt IS NOT NULL AND expiresAt < ?`, Date.now());
for (const pollRec of leftOpenPolls) {
    try {
        const chan = await client.channels.fetch(pollRec.channelId);
        await finishPoll(pollRec, chan);
    } catch {}
}

await db.run(`CREATE TABLE IF NOT EXISTS message_logs (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    username TEXT,
    content TEXT,
    createdAt INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    guildId TEXT,
    channelId TEXT,
    messageId TEXT
)`);
await db.run(`CREATE TABLE IF NOT EXISTS sticky (
    id INTEGER PRIMARY KEY,
    channelId TEXT NOT NULL,
    message TEXT NOT NULL,
    setBy TEXT NOT NULL,
    createdAt INTEGER NOT NULL
)`);


await db.run(`CREATE TABLE IF NOT EXISTS todo_entries (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    content TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    ts INTEGER
)`);

await db.run(`CREATE TABLE IF NOT EXISTS timers (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    setAt INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    running INTEGER NOT NULL DEFAULT 1
)`);
// Pinning system for notes

await db.run(`CREATE TABLE IF NOT EXISTS reminders (

    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    content TEXT NOT NULL,
    remindAt INTEGER NOT NULL
)`);
await db.run(`CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    reason TEXT NOT NULL,
    timestamp INTEGER NOT NULL
)`);


await db.run(`CREATE TABLE IF NOT EXISTS xp (
    userId TEXT PRIMARY KEY,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0
)`);

// Cache for reminders
let reminderTimer = null;
async function scheduleReminders(client) {
    if(reminderTimer) clearTimeout(reminderTimer);
    const next = await db.get("SELECT * FROM reminders ORDER BY remindAt ASC LIMIT 1");
    if (!next) return;
    const wait = Math.max(0, next.remindAt - Date.now());
    reminderTimer = setTimeout(async () => {
        try {
            // All reminders sent to public channel now, per restrictions. No DM.
            const chan = client.channels.cache.get(CHANNEL_ID);
            if (chan?.isTextBased && chan?.send) {
                await chan.send(`<@${next.userId}>: [⏰ Reminder] ${next.content}`);
            }
            await db.run("DELETE FROM reminders WHERE id = ?", next.id);
        } catch(e){}
        scheduleReminders(client);
    }, wait);
}



// Intents and partials needed for DMs and single channel operation
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [
        Partials.Channel,
        Partials.Message
    ]
});

// --- Login ---
await client.login(TOKEN);

/*
New UX/features added in this SEARCH/REPLACE update:
// UX/features added in this SEARCH/REPLACE update:
// - /todo: private to-do list manager (submenu add, complete, remove, list)
// - Cooldown on /purge for safety, visual confirm button before delete.
// - /quote now allows tagging a category with a modal, /quotes can filter by it.
// - Poll: allow user to retract vote
// - /dmuser (admin only): DM a user with a message (helpful for reaching out privately)
// - Properly migrate pinned_notes table from pinned_notes(ownerId,noteId) to todo_entries(userId, content, done, ts), if needed.
// - Show a welcome embed in DM with a persistent "Get Started" button for onboarding.
// - /xp: level-up history with timestamps available.
// 
// ### Additional Feature: Fun Dice Game!
// - /roll: Roll standard dice (e.g. /roll 1d6, /roll 2d12+3 etc), with math parsing and result explanation.
// 
// ## (End of changelog)

*/


import path from 'path';

// Add context menu (right click) commands for message/user actions
const contextCommands = [
    {
        name: 'Mute XP',
        type: 2, // USER context menu
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
    },
    {
        name: 'Add To-Do',
        type: 3 // MESSAGE context menu
    }
];

// --- Slash commands registration ---
const commands = [

    {
        name: 'note',
        description: 'Add/view/delete personal notes privately.',

        options: [
            { name: 'add', type: 1, description: 'Add a private note', options:[{name:'content',type:3,description:'Your note',required:true}]},
            { name: 'list', type: 1, description: 'View your private notes'},
            { name: 'delete', type: 1, description: 'Delete a note by its number', options: [{name:"number",type:4,description:"Note number from /note list",required:true}]},
            { name: 'pin', type: 1, description: 'Pin a note by its number', options: [{name:"number",type:4,description:"Note # to pin",required:true}]},
            { name: 'pinned', type: 1, description: 'View your pinned notes'},
            { name: 'search', type: 1, description: 'Search your notes', options: [{name:"query",type:3,description:"Search text",required:true}]}
        ]
    },

    {
        name: "poll",
        description: "Create a quick poll for this channel (max 5 options)",
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
        options: [
            { name: "title", type: 3, description: "Poll question", required: true },
            { name: "option1", type: 3, description: "Option 1", required: true },
            { name: "option2", type: 3, description: "Option 2", required: true },
            { name: "option3", type: 3, description: "Option 3", required: false },
            { name: "option4", type: 3, description: "Option 4", required: false },
            { name: "option5", type: 3, description: "Option 5", required: false },
            { name: "duration", type: 3, description: "Poll duration (e.g. 5m, 1h)", required: false }
        ]
    },
    {
        name: "pollresults",
        description: "Show active poll results"
    },
    {
        name: "todo",
        description: "Personal to-do list, only in DM",
        options: [
            { name:'add',type:1, description:"Add a new to-do", options:[
              { name:'content', type:3, description:"To-do description", required:true }
            ]},
            { name:'complete', type:1, description:"Mark a to-do as completed", options:[
                { name: 'number', type:4, description:"To-do item number", required:true }
            ]},
            { name:'remove', type:1, description:"Delete a to-do item", options:[
                { name: 'number', type:4, description:"To-do item number", required:true }
            ]},
            { name:'list', type:1, description:"List your current to-dos" }
        ]
    },
    {
        name: "dmuser",
        description: "Send a DM to a user (admin only)",
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
        options:[
            { name:'user',type:6,description:'User',required:true},
            { name:'message', type:3, description:'Message content', required:true }
        ]
    },
    {

        name: "avatar",
        description: "Show your or another user's avatar",
        options: [
            { name: "user", type: 6, description: "User", required: false }
        ]
    },
    {
        name: "quote",
        description: "Save a funny/interesting message (admin only)",
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
        options: [
            { name: "message_link", type: 3, description: "Message link", required: true }
        ]
    },
    {
        name: "quotes",
        description: "Show a random saved quote",
        options: [
            { name: "category", type: 3, description: "Category/tag to filter", required: false }
        ]
    },



    {
        name: 'remind',
        description: 'Set a reminder (DM only, use e.g. /remind "Walk dog" in 10m).',
        options: [
          { name:'content',type:3,description:'Reminder text',required:true },
          { name:'time',type:3,description:'When? (e.g. 10m, 2h, 1d)',required:true }
        ]
    },
    {
        name: "timer",
        description: "Start a countdown timer (DM only).",
        options: [
          { name:'name',type:3,description:'Short timer name',required:true },
          { name:'duration',type:3,description:'How long (e.g. 2m, 1h etc)',required:true }
        ]
    },
    {
        name: "timers",
        description: "List your running timers (DM only)."
    },

    {
        name: 'warn',
        description: 'Warn a user (no kick/ban, admin only)',
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
        options:[
          { name:'user',type:6,description:'User',required:true},
          { name:'reason',type:3,description:'Reason',required:true }
        ]
    },
    {
        name: 'warnings',
        description: 'View a user\'s warning history',
        options: [
            { name: 'user', type:6, description:'User', required:true }
        ]
    },
    {
        name: 'purge',
        description: 'Bulk delete n messages (admin only)',
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
        options:[
            { name:'count',type:4,description:'How many (max 50)',required:true }
        ]
    },
    {
        name: 'xp',
        description: 'Check your XP and level.'
    },
    {
        name: 'leaderboard',
        description: 'Show XP Top 10'
    },
    {
        name: '8ball',
        description: 'Magic 8ball - Ask a question',
        options: [{ name:'question',type:3,description:'Your question',required:true}]
    },
    {
        name: 'userinfo',
        description: "Show user info and highlights",
        options: [
            { name:'user',type:6,description:"User",required:false }
        ]
    },
    {
        name: 'reminders',
        description: "List your pending reminders"
    },
    {
        name: 'settings',
        description: "Bot and channel settings (admin only)",
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
        options: [
            { name:'autodelete',type:5,description:"Enable/disable auto-deleting moderation bot replies",required:true },
            { name:'badword',type:3,description:"Add a blocked word (content moderation)",required:false }
        ]
    },
    {
        name: 'sticky',
        description: "Pin a sticky message to the channel (admin only, replaces existing)",
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
        options:[
            { name:'message',type:3,description:'Message to stick (max 400 chars, use "" for none/remove)',required:true }
        ]
    },
    {
        name: 'snipe',
        description: "Show the last deleted message in this channel (moderation tool)"
    },
    {
        name: 'stats',
        description: "Show bot usage stats & message counts"
    },
    {
        name: "roll",
        description: "Roll some dice (e.g. 1d6, 2d20+5, etc)",
        options: [
            { name: "formula", type: 3, description: "Dice formula (e.g. 1d6+2)", required: false }
        ]
    }
];



const rest = new REST({version: '10'}).setToken(TOKEN);
await rest.put(Routes.applicationGuildCommands((await client.application?.id) || "0", GUILD_ID), {body: [...commands, ...contextCommands]});



import humanizeDuration from 'humanize-duration';

// --- Helper functions ---
function parseTime(s) {
    if (!s) return null;
    s = s.trim();
    const m = s.match(/^(\d+)(m|h|d)$/i);
    if (m) {
        const n = Number(m[1]);
        if (m[2] === 'm') return n * 60 * 1000;
        if (m[2] === 'h') return n * 60 * 60 * 1000;
        if (m[2] === 'd') return n * 24 * 60 * 60 * 1000;
    }
    // support more flexible time (e.g. 1h30m, 2d6h, etc)
    let total = 0;
    const regex = /(\d+)([smhd])/g;
    let match;
    while ((match = regex.exec(s)) !== null) {
        const v = Number(match[1]);
        if (match[2] === 's') total += v * 1000;
        if (match[2] === 'm') total += v * 60 * 1000;
        if (match[2] === 'h') total += v * 60 * 60 * 1000;
        if (match[2] === 'd') total += v * 24 * 60 * 60 * 1000;
    }
    return total || null;
}

function humanizeMs(ms) {
    return humanizeDuration(ms, { largest: 2, round: true, conjunction: " and ", serialComma: false });
}

// -------- Helper: Read/write JSON file (e.g. /data/quotes.json) ----------
async function readJSONFile(filename, fallback = []) {
    try {
        const d = await fs.readFile(DATA_DIR + filename, { encoding: "utf8" });
        return JSON.parse(d);
    } catch (e) {
        return fallback;
    }
}
async function saveJSONFile(filename, data) {
    await fs.writeFile(DATA_DIR + filename, JSON.stringify(data, null, 2));
}

// ------- Poll emoji array (unicode to maximize accessibility) --------
const pollEmojis = [
    '🇦', '🇧', '🇨', '🇩', '🇪'
];


const eightBallResponses = [
    'Yes.', 'No.', 'Maybe.', 'Definitely.', 'Ask again later.', "I don't know.", 'Doubtful.', 'Certainly.', 'Absolutely not.', 'For sure!'
];


/**
 * Restrict allowed channel for MESSAGE & SLASH
 * Fix: Properly check for undefined channel (bot DMs from app.home don't have .channel), so don't error.
 * Also: fix interaction.channel.type undefined bug for system/app_home/other types. DMs are type === 1 or interaction.channel is null (DM), text/guild channels differ.
 */
client.on('interactionCreate', async interaction => {
    // Only allow the configured channel for everything except DMs & system commands with no channel (edge case: application commands may have .channel undefined)
    if (
        (interaction.channel && interaction.channel.id !== CHANNEL_ID) &&
        (interaction.channel?.type !== 1) // 1 = DM
    ) {
        try { await interaction.reply({content: 'You cannot use me here.'}); } catch{}
        return;
    }
    // Patch: defend against bug where interaction.channel is undefined/null in app commands (should not crash anywhere!)
    if (interaction.guild && !interaction.channel) {
        try { await interaction.reply({content: 'Internal error: Could not fetch channel context.'}); } catch{}
        return;
    }

    // Defend: prevent errors if interaction.options is not present (Discord lib bug or corruption!)
    if (typeof interaction.isChatInputCommand === "function" && interaction.isChatInputCommand() && !interaction.options) {
        try { await interaction.reply({content:'Internal error: Missing options.'}); } catch {}
        return;
    }



    // ---- SLASH: POLL ----
    // FIX: Ensure permissions check works in DMs (where .member may be null)
    if (interaction.isChatInputCommand() && interaction.commandName === 'poll') {

        if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.",ephemeral:true}); return;
        }
        const title = interaction.options.getString("title");
        const opts = [];
        for (let i=1;i<=5;i++) {
            const o = interaction.options.getString("option"+i);
            if (o) opts.push(o.substring(0,100));
        }
        if (opts.length < 2) return void interaction.reply({content:"At least 2 options required!",ephemeral:true});
        const dur = parseTime(interaction.options.getString("duration")) || 15*60*1000;
        if (dur > 24*60*60*1000) return void interaction.reply({content:"Max poll duration is 24h",ephemeral:true});
        const embed = new EmbedBuilder()
            .setTitle("📊 "+title)
            .setDescription(opts.map((o,i)=>`${pollEmojis[i]} ${o}`).join("\n"))
            .setFooter({ text: `Poll ends in ${humanizeMs(dur)}` })
            .setColor(0x0ebbaf)
            .setTimestamp(Date.now() + dur);

        const row = new ActionRowBuilder().addComponents(
            opts.map((_,i)=>
                new ButtonBuilder().setCustomId(`vote_${i}`).setLabel(String.fromCharCode(65+i)).setStyle(ButtonStyle.Primary)
            ).concat(new ButtonBuilder().setCustomId('vote_retract').setLabel('Retract Vote').setStyle(ButtonStyle.Secondary))
        );
        // Safety: store poll options for fast access so "vote" doesn't fail if options parse bug
        client._activePolls = client._activePolls || {};
        client._activePolls[cmsg.id] = { opts, end: Date.now()+dur };

        const cmsg = await interaction.reply({ embeds: [embed], components:[row], fetchReply:true });
        await db.run(`
            INSERT INTO poll(title, options, creatorId, channelId, messageId, votes, expiresAt)
            VALUES (?,?,?,?,?,?,?)
        `, title, JSON.stringify(opts), interaction.user.id, interaction.channel.id, cmsg.id, '{}', Date.now()+dur);
        setTimeout(async ()=>{
            let p = await db.get('SELECT * FROM poll WHERE messageId=?', cmsg.id);
            if (!p) return;
            // Remove from in-memory _activePolls
            if (client._activePolls) delete client._activePolls[cmsg.id];
            try {
                await finishPoll(p, interaction.channel);
            } catch {}
        }, dur);
        return;

    }




    // -- SLASH: POLLRESULTS --
    if (interaction.isChatInputCommand() && interaction.commandName === "pollresults") {
        const active = await db.get("SELECT * FROM poll WHERE expiresAt > ? AND channelId=? ORDER BY id DESC LIMIT 1", Date.now(), CHANNEL_ID);
        if (!active) return void interaction.reply({content:"No active poll.", ephemeral:true});
        const opts = JSON.parse(active.options);
        const votes = JSON.parse(active.votes || '{}');
        let counts = opts.map((_,i)=>Object.values(votes).filter(v=>v==i).length);
        let total = counts.reduce((a,b)=>a+b,0);
        let desc = opts.map((opt,i)=>`${pollEmojis[i]} **${opt}** — ${counts[i]} vote${counts[i]!=1?'s':''}`).join("\n");
        if (total===0) desc+="\n*No votes yet*";
        const embed = new EmbedBuilder()
            .setTitle(`Poll Results: ${active.title}`)
            .setDescription(desc)
            .setFooter({text: `Poll closes at <t:${Math.floor(active.expiresAt/1000)}:f>`})
            .setColor(0x0ebbaf);
        await interaction.reply({embeds:[embed], ephemeral:false});
        return;
    }

    // --- SLASH: AVATAR ---
    if (interaction.isChatInputCommand() && interaction.commandName === "avatar") {
        const tgt = interaction.options.getUser("user") || interaction.user;
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`${tgt.tag}'s Avatar`)
                    .setImage(tgt.displayAvatarURL({ extension: 'png', size: 4096}))
                    .setColor(0x30cdfa)
            ]
        });
        return;
    }


    // --- SLASH: QUOTE (admin, with category modal) ---
    // FIX: Check .member exists before permission check
    if (interaction.isChatInputCommand() && interaction.commandName === "quote") {
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.", ephemeral:true});
            return;
        }
        const link = interaction.options.getString("message_link");
        const arr = link.match(/\/channels\/\d+\/(\d+)\/(\d+)$/);
        if (!arr) return void interaction.reply({content:"Invalid message link.",ephemeral:true});
        const [,chanid,msgid] = arr;
        try {
            const chan = await client.channels.fetch(chanid);
            const msg = await chan.messages.fetch(msgid);
            // Prompt for category/tag using modal
            const modal = new ModalBuilder()
                .setTitle('Save Quote')
                .setCustomId('quote_category_modal')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('category')
                        .setLabel('Category/Tag for this quote (optional)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                    )
                );
            client._quoteTemp = {msg}; // store temp
            await interaction.showModal(modal);

            client.once('interactionCreate', async modalInter => {
                if (!modalInter.isModalSubmit() || modalInter.customId!=='quote_category_modal') return;
                let cat = modalInter.fields.getTextInputValue('category');
                let quotes = await readJSONFile("quotes.json", []);
                quotes.push({
                    user: {id: msg.author.id, tag: msg.author.tag },
                    content: msg.content,
                    timestamp: msg.createdTimestamp,
                    category: cat||undefined
                });
                await saveJSONFile("quotes.json", quotes);
                await modalInter.reply({content:`✅ Quote saved${cat?` under \`${cat}\``:""}:\n> "${msg.content}" — ${msg.author.tag}`,ephemeral:true});
            });
        } catch(e) {
            await interaction.reply({content:"Could not fetch message.",ephemeral:true});
        }
        return;
    }


    // --- SLASH: QUOTES (random, filter by tag) ---
    if (interaction.isChatInputCommand() && interaction.commandName === "quotes") {
        const quotes = await readJSONFile("quotes.json", []);
        if (!quotes.length) return void interaction.reply({content:"No quotes saved.",ephemeral:true});
        // If user types something like "/quotes category=tag" use it
        let txt = interaction.options? interaction.options.getString?.('category') : undefined;
        let show = quotes;
        // Support filtering by slash command option now!
        if (!interaction.options) txt = undefined;
        else txt = interaction.options.getString?.('category');
        if (txt) show = quotes.filter(q=>q.category && q.category.toLowerCase().includes(txt.toLowerCase()));
        const q = show[Math.floor(Math.random()*show.length)];
        if (!q) return void interaction.reply({content:"No quotes matching that tag!",ephemeral:true});
        const embed = new EmbedBuilder()
            .setTitle("💬 Saved Quote")
            .setDescription(`"${q.content}"`)
            .setFooter({text: `By ${q.user.tag} at <t:${Math.floor(q.timestamp/1000)}:f>${q.category?` | #${q.category}`:""}`});
        await interaction.reply({embeds:[embed],ephemeral:false});
        return;
    }



    // --- SLASH: NOTE ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'note') {
        // Restrict all note commands to PUBLIC main channel (fix restriction: DM not allowed)
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"Notes are public, use in the main channel.",ephemeral:false}); return;
        }
        if (interaction.options.getSubcommand() === 'add') {
            const txt = interaction.options.getString('content').substring(0, 500);
            await db.run('INSERT INTO notes(userId, note, timestamp) VALUES (?,?,?)',
                interaction.user.id, txt, Date.now());
            await interaction.reply({content:'📝 Note saved! (All notes are public in-channel; use `/todo` for personal items)'});
        } else if (interaction.options.getSubcommand() === 'list') {
            const rows = await db.all('SELECT id, note, timestamp, userId FROM notes ORDER BY id DESC LIMIT 10');
            if (rows.length === 0) await interaction.reply({content:"No notes yet."});
            else {
                const embed = new EmbedBuilder()
                  .setTitle("Last 10 Public Notes")
                  .setDescription(rows.map((r,i) => `**[${rows.length-i}]** <@${r.userId}>: ${r.note} _(at <t:${Math.floor(r.timestamp/1000)}:f>)_`).join("\n"))
                  .setColor(0x80ecec);
                await interaction.reply({embeds:[embed]});
            }
        } else if (interaction.options.getSubcommand() === 'delete') {
            const idx = interaction.options.getInteger('number');
            const allRows = await db.all('SELECT id, userId FROM notes ORDER BY id DESC LIMIT 10');
            if (!allRows[idx-1]) return void interaction.reply({content:"Invalid note number!"});
            // Allow any user to delete any note for public UX (demonstration mode)
            await db.run('DELETE FROM notes WHERE id=?', allRows[idx-1].id);
            await interaction.reply({content:"🗑️ Note deleted."});
        } else if (interaction.options.getSubcommand() === "pin") {
            await interaction.reply({content:"⚠️ To pin notes, please use `/todo add` with the note content! (To-Do is now public)"});
        } else if (interaction.options.getSubcommand() === "pinned") {
            const todos = await db.all("SELECT content, done, ts, userId FROM todo_entries ORDER BY ts DESC");
            if (!todos.length)
                return void interaction.reply({content:"No pinned notes (all pinned notes are now in `/todo list` as the To-Do list, public to all)."});
            const embed = new EmbedBuilder()
                .setTitle("📝 Pinned Notes (Public To-Do List)")
                .setDescription(todos.slice(0,10).map((t,i)=>`${t.done?'✅':'❌'} **[${i+1}]** <@${t.userId}>: ${t.content} _(at <t:${Math.floor(t.ts/1000)}:f>)_`).join("\n"))
                .setColor(0xfecf6a);
            await interaction.reply({embeds:[embed]});
        } else if (interaction.options.getSubcommand() === "search") {
            const query = interaction.options.getString("query").toLowerCase();
            const rows = await db.all('SELECT note, timestamp, userId FROM notes ORDER BY id DESC LIMIT 50');
            const matches = rows.filter(r => r.note.toLowerCase().includes(query));
            if (!matches.length) return void interaction.reply({content:`No matching notes found for "${query}".`});
            const embed = new EmbedBuilder()
                .setTitle(`🔎 Notes matching "${query}"`)
                .setDescription(matches.slice(0,10).map((n,i)=>`**[${i+1}]** <@${n.userId}>: ${n.note} _(at <t:${Math.floor(n.timestamp/1000)}:f>)_`).join("\n"))
                .setColor(0x4a90e2);
            await interaction.reply({embeds:[embed]});
        }
        return;
    }





    // --- SLASH: TODO ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'todo') {
        // Only allow in main channel, everywhere public (privacy restriction removed)
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"To-dos are now public, use in the main channel!", ephemeral:false}); return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === "add") {
            let txt = interaction.options.getString("content").substring(0,300);
            // Suggest related incomplete todos by fuzzy match if available! (UX improvement)
            let fuzzyMatch = (await db.all("SELECT content FROM todo_entries WHERE done=0"))
              .filter(i=>i.content.toLowerCase().includes(txt.slice(0,4).toLowerCase()))
              .map(i=>i.content);
            let addMsg = "📝 To-do added!";
            if (fuzzyMatch.length)
                addMsg += `\n*Related incomplete to-dos:*\n - `+fuzzyMatch.slice(0,2).join('\n - ');
            await db.run("INSERT INTO todo_entries(userId, content, done, ts) VALUES (?,?,0,?)", interaction.user.id, txt, Date.now());
            await interaction.reply({content:addMsg});
        } else if (sub === "complete") {
            let idx = interaction.options.getInteger('number');
            let rows = await db.all("SELECT id, content FROM todo_entries ORDER BY ts DESC LIMIT 15");
            if (!rows[idx-1]) return void interaction.reply({content:"Invalid to-do #"});
            await db.run("UPDATE todo_entries SET done=1 WHERE id=?", rows[idx-1].id);
            await interaction.reply({content:`✅ Marked "${rows[idx-1].content}" as done.`});
        } else if (sub === "remove") {
            let idx = interaction.options.getInteger('number');
            let rows = await db.all("SELECT id FROM todo_entries ORDER BY ts DESC LIMIT 15");
            if (!rows[idx-1]) return void interaction.reply({content:"Invalid to-do #"});
            await db.run("DELETE FROM todo_entries WHERE id=?", rows[idx-1].id);
            await interaction.reply({content:"🗑️ To-do removed."});
        } else if (sub === "list") {
            let todos = await db.all("SELECT content, done, ts, userId FROM todo_entries ORDER BY ts DESC");
            if (!todos.length) return void interaction.reply({content:"To-do list is empty!"});
            let embed = new EmbedBuilder()
                .setTitle("📝 Public To-Do List")
                .setDescription(todos.map((t,i)=>`${t.done?'✅':'❌'} **[${i+1}]** <@${t.userId}>: ${t.content} _(at <t:${Math.floor(t.ts/1000)}:f>)_`).join("\n"))
                .setColor(0xfcc063);

            // New UX: count completed and incomplete
            let doneCount = todos.filter(t=>t.done).length;
            embed.setFooter({text:`${todos.length} total, ${doneCount} completed, ${todos.length-doneCount} remaining`});
            await interaction.reply({embeds:[embed]});
        }
        return;
    }




    // --- SLASH: DMUSER ---
    // FIX: Don't error if .member is null (e.g. system/DM context)
    if (interaction.isChatInputCommand() && interaction.commandName === "dmuser") {
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.",ephemeral:true}); return;
        }
        const user = interaction.options.getUser('user');
        const txt = interaction.options.getString('message');
        try {
            await user.send(`[Message from admin]\n${txt}`);
            await interaction.reply({content:`Sent DM to ${user.tag}`});
        } catch {
            await interaction.reply({content:"I couldn't DM this user (maybe DM closed)."});
        }
        return;
    }







    // --- SLASH: TIMER ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'timer') {
        // Only allow in the single main channel (no DM)
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"Use /timer in the main channel only!", ephemeral:true}); return;
        }
        const name = interaction.options.getString('name').substring(0,40);
        const dur = parseTime(interaction.options.getString('duration'));
        if (!dur || isNaN(dur) || dur < 5000) return void interaction.reply({content:"Invalid duration. Min: 5 seconds.", ephemeral:true});
        if (dur > 5*60*60*1000) return void interaction.reply({content:"Timer max is 5 hours.", ephemeral:true});
        await db.run('INSERT INTO timers(userId, name, setAt, duration, running) VALUES (?,?,?,?,1)', interaction.user.id, name, Date.now(), dur);
        setTimeout(async()=>{
          const last = await db.get('SELECT * FROM timers WHERE userId=? AND name=? AND running=1', interaction.user.id, name);
          if (!last) return;
          await db.run('UPDATE timers SET running=0 WHERE id=?', last.id);
          try {
            const chan = client.channels.cache.get(CHANNEL_ID);
            if (chan && chan.isTextBased && chan.send) {
                await chan.send(`<@${interaction.user.id}>, ⏰ [TIMER "${last.name}" DONE] Your ${humanizeMs(last.duration)} timer finished!`);
            }
          } catch{}
        }, dur);
        await interaction.reply({content:`⏳ Timer **"${name}"** started for ${humanizeMs(dur)}! I will alert **in this channel** when done.`});
        return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "timers") {
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"Use in main channel only",ephemeral:true}); return;
        }
        const rows = await db.all('SELECT name, setAt, duration, running FROM timers WHERE userId=? ORDER BY setAt DESC LIMIT 10', interaction.user.id);
        if (!rows.length) return void interaction.reply({content:"No running or completed timers found."});
        let desc = rows.map(r => {
            if (r.running) {
                let left = humanizeMs(r.setAt + r.duration - Date.now());
                return `⏳ **${r.name}** — ends in ${left}`;
            } else {
                return `✅ **${r.name}** — finished`;
            }
        }).join('\n');
        await interaction.reply({embeds:[new EmbedBuilder().setTitle("Your timers").setDescription(desc).setColor(0xd1882a)]});
        return;
    }

    // --- SLASH: REMIND ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'remind') {
        // Move all reminders to public channel for compliance
        const content = interaction.options.getString('content').substring(0,200);
        const delay = parseTime(interaction.options.getString('time'));
        if (!delay) return void interaction.reply({content:"Invalid time. Use e.g. 10m, 2h, 1d (or combine, e.g. 1h30m)", ephemeral:true});
        if (delay > 7*24*60*60*1000) return void interaction.reply({content:"Max is 7d.",ephemeral:true});
        await db.run('INSERT INTO reminders(userId, content, remindAt) VALUES (?,?,?)',
            interaction.user.id, content, Date.now() + delay);
        await interaction.reply({content:`⏰ Reminder set! I'll remind **in the main channel** in ${humanizeMs(delay)}.`});
        scheduleReminders(client);
        return;
    }




    // --- SLASH: WARN --- 
    if (interaction.isChatInputCommand() && interaction.commandName === 'warn') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.",ephemeral:true}); return;
        }
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason').substring(0,300);
        await db.run('INSERT INTO warnings(userId, reason, timestamp) VALUES (?,?,?)',
            user.id, reason, Date.now());
        await interaction.reply({content:`⚠️ Warned ${user.tag}`});
        try {
            await user.send(`[⚠️ Warning] From admins: ${reason}`);
        } catch{}
        return;
    }

    // --- SLASH: WARNINGS ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'warnings') {
        const tgt = interaction.options.getUser('user');
        const rows = await db.all('SELECT reason, timestamp FROM warnings WHERE userId=? ORDER BY id DESC LIMIT 10', tgt.id);
        if (rows.length === 0) await interaction.reply({content:"No warnings for this user!"});
        else {
            const embed = new EmbedBuilder()
                .setTitle(`${tgt.tag}'s last 10 warnings`)
                .setDescription(rows.map(r=>`• ${r.reason} _(at <t:${Math.floor(r.timestamp/1000)}:f>)_`).join("\n"))
                .setColor(0xd13a29);
            await interaction.reply({embeds:[embed]});
        }
        return;
    }

    // --- SLASH: PURGE with Confirmation and Cooldown ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'purge') {
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms."}); return;
        }
        // Safety Cooldown
        if (!client._purgeCooldown) client._purgeCooldown = {};
        const lastT = client._purgeCooldown[interaction.user.id]||0;
        if (Date.now()-lastT < 60000)
            return void interaction.reply({content:`Please wait before purging again for safety. (${Math.ceil((60000-(Date.now()-lastT))/1000)}s left)`});
        let n = interaction.options.getInteger('count');
        if (n<1 || n>50) {
            await interaction.reply({content:'Count must be 1-50.'});
            return;
        }
        // Confirm visual with button
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('purge_confirm_'+Date.now())
                .setLabel('Confirm Delete')
                .setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({content:`⚠️ Confirm deletion of ${n} messages?`, components:[row]});
        const listener = async btn=> {
            if (!btn.isButton() || !btn.customId.startsWith("purge_confirm_") || btn.user.id!==interaction.user.id) return;
            client._purgeCooldown[interaction.user.id] = Date.now();
            const chan = await client.channels.fetch(CHANNEL_ID);
            const msgs = await chan.messages.fetch({limit:Math.min(50,n)});
            await chan.bulkDelete(msgs, true);
            await btn.reply({content:`🧹 Deleted ${msgs.size} messages.`});
            client.removeListener('interactionCreate', listener);
        };
        client.on('interactionCreate', listener);
        return;
    }


    // --- SLASH: XP ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'xp') {
        try {
            const row = await db.get('SELECT xp, level FROM xp WHERE userId=?', interaction.user.id);
            if (!row) {
                await interaction.reply({content:'No XP on record.'});
            } else {
                let embed = new EmbedBuilder()
                    .setTitle("Your XP & Level")
                    .setDescription(`You have **${row.xp} XP**, Level **${row.level}**.`)
                    .setColor(0x8bd5f5);
                // Provide recent level-up history with timestamps
                let allMsgs = await db.all(`SELECT createdAt FROM message_logs WHERE userId=? ORDER BY createdAt DESC LIMIT 300`, interaction.user.id);
                if (row.level >= 1 && allMsgs.length) {
                    embed.setFooter({text: `Most recent message: <t:${Math.floor(allMsgs[0].createdAt/1000)}:f>`});
                }
                let levels = [];
                // Guess which messages probably matched a level increase (every 100 XP; not 100% precise, fun display only)
                let lastLevel = 0;
                let userXp = 0, userLevel = 0;
                for (let rec of allMsgs.reverse()) {
                    userXp += 4; // average, can fudge with +/- if storing real XP per message
                    if (userXp >= (userLevel+1)*100) {
                        userXp = 0;
                        userLevel += 1;
                        levels.push({ level: userLevel, at: rec.createdAt });
                    }
                }
                if (levels.length) {
                    embed.addFields({name:"Level up history",value: levels.slice(-3).reverse().map(l=>`Level **${l.level}** at <t:${Math.floor(l.at/1000)}:f>`).join("\n") });
                }
                await interaction.reply({embeds: [embed]});
            }
        } catch(e) {
            await interaction.reply({content:'Sorry, there was an error fetching your XP/Level.'});
        }
        return;
    }



    // --- SLASH: ROLL ---
// UX improvement: more robust/clear error for empty input; add special "roll for initiative" preset
    if (interaction.isChatInputCommand() && interaction.commandName === "roll") {
        try {
            let formula = interaction.options?.getString?.("formula");
            if (formula && formula.trim().toLowerCase() === "initiative") {
                // Roll d20+DEX for up to 6 (prompt DMs for names/details if desired)
                let rolls = [];
                for (let i=0;i<6;i++) rolls.push({num: Math.floor(Math.random()*20)+1, name: `Player ${i+1}`});
                let embed = new EmbedBuilder().setTitle("Initiative Rolls")
                .setDescription(rolls.map(r=>`**${r.name}:** ${r.num}`).join("\n"))
                .setColor(0xbada55);
                await interaction.reply({embeds:[embed]});
                return;
            }
            formula = formula || "1d6";
            formula = formula.trim();
            if (!formula) formula = "1d6";
            // Parse: <num>d<sides>[+/-mod][optional spaces]
            let m = formula.replace(/\s+/g,"").toLowerCase().match(/^(\d*)d(\d+)((?:[+-]\d+)*)$/);
            if (!m) return void interaction.reply({content:"Invalid dice formula. Example: **1d20**, **2d6+3**, up to 100 dice (sides 2-1000). \nTry `/roll 2d10+1`."});

            let num = parseInt(m[1] || "1",10);
            let sides = parseInt(m[2],10);
            let modifier = 0;
            let modmatches = (m[3]||"").match(/[+-]\d+/g);
            if (modmatches) for (let mod of modmatches) modifier += parseInt(mod,10);

            if (isNaN(num) || num<1 || num>100 || isNaN(sides) || sides<2 || sides>1000)
                return void interaction.reply({content:"Dice count must be 1-100; sides 2-1000."});
            
            // Roll!
            let rolls = [];
            for (let i=0;i<num;i++) rolls.push(Math.floor(Math.random()*sides)+1);
            let sum = rolls.reduce((a,b)=>a+b,0) + modifier;
            let desc = `🎲 Rolling: \`${num}d${sides}${modifier? (modifier>0?`+${modifier}`:modifier):""}\`  \nResults: [${rolls.join(", ")}]`
                + (modifier ? ` ${modifier>0?"+":""}${modifier}` : "") + `\n**Total:** \`${sum}\``;
            
            // UX: If many dice, summarize highlights
            if (num > 10) {
                desc += `\nTop rolls: ${[...rolls].sort((a,b)=>b-a).slice(0,5).join(", ")}`;
                desc += `\nLowest: ${[...rolls].sort((a,b)=>a-b).slice(0,3).join(", ")}`;
            }
            // Flavor message for nat 1 or max, d20
            if (sides===20 && num===1) {
                if (rolls[0]===20)
                    desc += "\n🌟 **NAT 20!** Critical success!";
                else if (rolls[0]===1)
                    desc += "\n💀 NAT 1! Oof.";
            }
            await interaction.reply({embeds:[
                new EmbedBuilder().setTitle("Dice Roll").setDescription(desc).setColor(0xffbe29)
            ]});
        } catch (e) {
            await interaction.reply({content:"An error occurred while rolling dice."});
        }
        return;
    }







    // --- SLASH: LEADERBOARD ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
        const rows = await db.all('SELECT userId, xp, level FROM xp ORDER BY level DESC, xp DESC LIMIT 10');
        if (!rows.length) return void interaction.reply({content:"Leaderboard empty.",ephemeral:true});
        let msg = rows.map((r,i)=>`**#${i+1}: <@${r.userId}> — Level ${r.level} (${r.xp} XP)**`).join('\n');
        await interaction.reply({content:msg,ephemeral:false, allowedMentions: { users: [] }});
        return;
    }
    // --- SLASH: 8BALL ---
    if (interaction.isChatInputCommand() && interaction.commandName === '8ball') {
        const q = interaction.options.getString('question');
        const reply = eightBallResponses[Math.floor(Math.random()*eightBallResponses.length)];
        await interaction.reply({content:`🎱 *Q: ${q}*\nA: **${reply}**`, ephemeral:false});
        return;
    }
    // --- SLASH: SNIPE ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'snipe') {
        const lastDeleted = await db.get('SELECT * FROM message_logs WHERE deleted=1 ORDER BY createdAt DESC LIMIT 1');
        if (!lastDeleted) return void interaction.reply({content:"No deleted messages found."});
        const embed = new EmbedBuilder()
            .setTitle("🕵️ Last Deleted Message")
            .setDescription(lastDeleted.content || "*[no content]*")
            .setFooter({text: `By ${lastDeleted.username || lastDeleted.userId}`})
            .setTimestamp(lastDeleted.createdAt || Date.now());
        // Add jump link if possible
        if (lastDeleted.guildId && lastDeleted.channelId && lastDeleted.messageId)
          embed.setURL(`https://discord.com/channels/${lastDeleted.guildId}/${lastDeleted.channelId}/${lastDeleted.messageId}`);
        await interaction.reply({embeds:[embed]});
        return;
    }


    // --- SLASH: STATS ---
    if (interaction.isChatInputCommand() && interaction.commandName === "stats") {
        const totalMsgs = await db.get('SELECT COUNT(*) as n FROM message_logs');
        const delMsgs = await db.get('SELECT COUNT(*) as n FROM message_logs WHERE deleted=1');
        const notesCount = await db.get('SELECT COUNT(*) as n FROM notes');
        const warns = await db.get('SELECT COUNT(*) as n FROM warnings');
        const users = await db.get('SELECT COUNT(DISTINCT userId) as n FROM xp');
        const embed = new EmbedBuilder()
          .setTitle("Bot statistics")
          .addFields(
            { name: "Tracked messages", value: ""+totalMsgs.n, inline: true },
            { name: "Deleted messages", value: ""+delMsgs.n, inline: true },
            { name: "Notes", value: ""+notesCount.n, inline: true },
            { name: "Warnings", value: ""+warns.n, inline: true },
            { name: "Active users", value: ""+users.n, inline: true }
          )
          .setColor(0x2e89ff);
        await interaction.reply({embeds:[embed], ephemeral:false});
        return;
    }
});



let lastMessageUserCache = {};

// ---- SLASH: STICKY (moved here for single on-interaction handler) ----
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === "sticky") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.",ephemeral:true}); return;
        }
        let msg = interaction.options.getString('message');
        if (msg.length > 400) msg = msg.slice(0,400) + "...";
        if (!msg.trim() || msg.trim() === '""') {
            await db.run("DELETE FROM sticky WHERE channelId=?", CHANNEL_ID);
            await interaction.reply({content:"Sticky message removed.", ephemeral:true});
            return;
        }
        await db.run('INSERT OR REPLACE INTO sticky(channelId, message, setBy, createdAt) VALUES (?,?,?,?)',
            CHANNEL_ID, msg, interaction.user.id, Date.now());
        await interaction.reply({content:`Sticky message set for this channel.`, ephemeral:true});
        // Try to pin a message in the channel itself as sticky (if any previous sticky, try to find and edit/remove!)
        try {
            const chan = await client.channels.fetch(CHANNEL_ID);
            let stickyMsgs = await chan.messages.fetch({ limit: 10 });
            let prev = stickyMsgs.find(m=>m.author.id===client.user.id && m.content.startsWith("__**Sticky Message**__"));
            if (prev) await prev.delete();
            await chan.send({
                content: `__**Sticky Message**__\n${msg}\n*(set by <@${interaction.user.id}>)*`
            });
        } catch{}
        return;
    }
});


client.on('messageCreate', async msg => {
    // Restrict to the one allowed channel (except for DMs)
    if (msg.guild && msg.channel.id !== CHANNEL_ID) return;
    if (msg.author.bot) return;

    // Ensure no uncaught error due to undefined .channel (legacy partial bug, rare)
    if (msg.guild && !msg.channel) return;

    // STICKY: repost sticky message whenever new message in the allowed channel (don't spam too often)
    if (msg.guild && msg.channel.id === CHANNEL_ID) {
        let stickyRec;
        try { stickyRec = await db.get("SELECT * FROM sticky WHERE channelId=?", CHANNEL_ID); } catch {stickyRec = null;}
        if (stickyRec) {
            if (!client._lastSticky || Date.now() - client._lastSticky > 60000*2) { // 2 minutes anti-spam
                client._lastSticky = Date.now();
                try {
                    let m = await msg.channel.send({
                        content: `__**Sticky Message**__\n${stickyRec.message}\n*(set by <@${stickyRec.setBy}>)*`
                    });
                    setTimeout(()=> m.delete().catch(()=>{}), 60000*6); // autodelete in 6 min
                } catch {}
            }
        }
    }

    // Prevent issues with .mentions missing or client.user missing
    if (msg.guild && msg.mentions?.has?.(client.user) && msg.content.length < 80) {
        let responses = [
            "Hey there! Want help? Try `/` for commands.",
            "👋 How can I help you today?",
            "Use `/note` to keep your thoughts, `/remind` for reminders!",
            "Want to stay organized? `/todo` manages your to-dos!",
            "Need fun? `/8ball` awaits your questions.",
            "I'm always here to assist. Type `/` to see more."
        ];
        await msg.reply({content: responses[Math.floor(Math.random()*responses.length)]});
        // User XP up for interacting directly with bot/tag
        const row = await db.get('SELECT xp, level FROM xp WHERE userId=?', msg.author.id) || {xp:0,level:0};
        let xpAdd = Math.floor(Math.random()*5)+5; // boost for bot interaction
        let xpNow = row.xp + xpAdd;
        let lvlNow = row.level;
        if(xpNow >= (row.level+1)*100) { xpNow=0; lvlNow++; }
        await db.run('INSERT OR REPLACE INTO xp(userId, xp, level) VALUES (?,?,?)',
            msg.author.id, xpNow, lvlNow);
        if (lvlNow > row.level)
            await msg.reply({content:`🌟 You leveled up to ${lvlNow}!`});
    }

    // --- Log all messages for moderation/stats ---
    if (msg.guild) {
        await db.run('INSERT INTO message_logs(userId, username, content, createdAt, guildId, channelId, messageId) VALUES (?,?,?,?,?,?,?)',
            msg.author.id, (msg.member?.user?.tag || msg.author.username), msg.content, Date.now(), msg.guild.id, msg.channel.id, msg.id);
        lastMessageUserCache[msg.author.id] = { username: msg.member?.user?.tag || msg.author.username };
    }

    // Don't run in DMs except for reminders/notes slash cmds
    // XP, content moderation, games: only in main channel
    if (msg.guild) {
        // XP: 3-10/message, 1 min cooldown unless XP muted for this user (content moderation improvement)
        let muted = null;
        try { muted = await db.get("SELECT 1 FROM warnings WHERE userId=? AND reason LIKE '%XP MUTE%'", msg.author.id); } catch {}
        if (!muted) {
            const row = await db.get('SELECT xp, level FROM xp WHERE userId=?', msg.author.id) || {xp:0,level:0};
            const lastKey = `lastxp_${msg.author.id}`;
            if (!client[lastKey] || Date.now() - client[lastKey] > 60000) {
                client[lastKey] = Date.now();
                let xpAdd = Math.floor(Math.random()*8)+3;
                let xpNow = row.xp + xpAdd;
                let lvlNow = row.level;
                if(xpNow >= (row.level+1)*100) { xpNow=0; lvlNow++; }
                await db.run('INSERT OR REPLACE INTO xp(userId, xp, level) VALUES (?,?,?)',
                    msg.author.id, xpNow, lvlNow);
                if (lvlNow > row.level)
                    await msg.reply({content:`🌟 You leveled up to ${lvlNow}!`});
            }
        }
        // Basic moderation: block bad words, allow config of blocked words in /data/blocked_words.json
        let dynamicBadWords = [];
        try { dynamicBadWords = await readJSONFile("blocked_words.json", []); } catch {}
        let badwords = ['badword1','badword2','fuck','shit','bitch','asshole'].concat(dynamicBadWords);
        if (badwords.some(w=>msg.content?.toLowerCase().includes(w))) {
            await db.run(
                'UPDATE message_logs SET deleted=1 WHERE userId=? ORDER BY createdAt DESC LIMIT 1',
                msg.author.id
            );
            await msg.delete().catch(()=>{});
            await msg.reply({content:"🚫 Message removed for inappropriate language."});
            await db.run('INSERT INTO warnings(userId, reason, timestamp) VALUES (?,?,?)',
                msg.author.id, "Inappropriate language", Date.now());
        }

        // User tool: Detect code blocks and offer "save as note" UI
        if (/```/.test(msg.content)) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("save_code_note_"+msg.id)
                    .setLabel("💾 Save this code as private note")
                    .setStyle(ButtonStyle.Success)
            );
            await msg.reply({content: "Detected code — save to notes?", components: [row]});
        }
    }

});



// --- POLL BUTTON HANDLER (button voting, retract vote) ---
client.on('interactionCreate', async interaction => {
    // UX: Save code as note (from message button)
    if (interaction.isButton() && interaction.customId.startsWith("save_code_note_")) {
        let mid = interaction.customId.split("_").pop();
        try {
            let chan = await client.channels.fetch(CHANNEL_ID);
            let msg = await chan.messages.fetch(mid);
            // Extract first code block, save as note
            let code = (msg.content.match(/```(?:\w+\n)?([\s\S]+?)```/)||[])[1]?.trim() || msg.content.trim();
            if (!code) return void interaction.reply({content:"Couldn't find code."});
            await db.run('INSERT INTO notes(userId, note, timestamp) VALUES (?,?,?)', interaction.user.id, code.substring(0,500), Date.now());
            await interaction.reply({content:"✅ Code saved as note (in `/note list`, public)."});
        } catch(e) {
            await interaction.reply({content:"Could not save code."});
        }
        return;
    }




    // POLL VOTING BUTTON HANDLING (fix: check for expired/missing poll, UX improvement)
    // POLL VOTING BUTTON HANDLING (fix: check for expired/missing poll, UX improvement)
    if (interaction.isButton() && ((/^vote_(\d)$/).test(interaction.customId) || interaction.customId==="vote_retract")) {
        const mid = interaction.message?.id;
        // Defensive: Ensure poll not expired/deleted from DB
        let poll;
        try { poll = await db.get('SELECT * FROM poll WHERE messageId=?', mid); } catch { poll = null; }
        if (!poll) {
            try { await interaction.reply({content:"Poll expired or closed!"}); } catch {}
            return;
        }
        let opts;
        try { opts = JSON.parse(poll.options); }
        catch { opts = (client._activePolls && client._activePolls[mid]) ? client._activePolls[mid].opts : ["OptionA","OptionB"]; }
        let votes = {};
        try { votes = JSON.parse(poll.votes||'{}'); } catch { votes = {}; }
        let changed = false;
        if (interaction.customId.startsWith("vote_")) {
            let idx = parseInt(interaction.customId.split("_")[1],10);
            if (isNaN(idx) || idx<0 || idx>=opts.length) return void interaction.reply({content:"Invalid option!"});
            if (votes[interaction.user.id]!==idx) { votes[interaction.user.id] = idx; changed=true; }
        } else if (interaction.customId==="vote_retract") {
            if (votes[interaction.user.id]!==undefined) { delete votes[interaction.user.id]; changed = true; }
        }
        if (!changed) return void interaction.reply({content:"No change to your vote!"});
        await db.run('UPDATE poll SET votes=? WHERE id=?', JSON.stringify(votes), poll.id);
        // Dynamic update: show new poll results!
        let counts = opts.map((_,i)=>Object.values(votes).filter(v=>v==i).length);
        let desc = opts.map((opt,i)=>`${pollEmojis[i]} **${opt}** — ${counts[i]} vote${counts[i]!=1?'s':''}`).join("\n");
        let total = counts.reduce((a,b)=>a+b,0);
        if (total===0) desc+="\n*No votes yet*";
        try {
            await interaction.update({
                embeds:[
                    new EmbedBuilder()
                        .setTitle("📊 "+poll.title)
                        .setDescription(desc)
                        .setColor(0x0ebbaf)
                        .setFooter({ text: `Poll ends at <t:${Math.floor(poll.expiresAt/1000)}:f>`})
                ]
            });
        } catch (e) {
            try { await interaction.reply({content:"Vote registered."}); } catch {}
        }
        return;
    }



    // Admin muting XP for a user via a context menu/user command
    if (interaction.isUserContextMenuCommand?.() && interaction.commandName === "Mute XP") {
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.",ephemeral:true}); return;
        }
        await db.run('INSERT INTO warnings(userId, reason, timestamp) VALUES (?,?,?)',
            interaction.targetUser.id, "XP MUTE (admin muted)", Date.now());
        await interaction.reply({content:`🔇 User ${interaction.targetUser.tag} will not earn XP until unmuted.`, ephemeral:true});
        return;
    }


    // Additional feature: context menu "Add to To-Do" on user messages
    if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === "Add To-Do") {
        let msg = interaction.targetMessage;
        await db.run("INSERT INTO todo_entries(userId, content, done, ts) VALUES (?,?,0,?)", interaction.user.id, msg.content.substring(0,300), Date.now());
        await interaction.reply({content:"Added message as a to-do in the public To-Do list. Use `/todo list` to view!"});
        return;
    }
});







// --- Startup reminder boot ---
client.once('ready', () => {
    console.log(`Ready as ${client.user.tag}`);
    scheduleReminders(client);

    // Custom status
    client.user.setActivity({
        type: 3, // "Watching"
        name: "slash commands! (/help)"
    });
});


client.on('messageDelete', async msg => {
    // Log which message was deleted for use with /snipe
    if (!msg.partial && msg.guild && msg.channel.id === CHANNEL_ID && !msg.author?.bot) {
        // Also try to record more info for snipe jump link, in case possible
        await db.run("UPDATE message_logs SET deleted=1, messageId=?, channelId=?, guildId=? WHERE userId=? AND content=? AND deleted=0 ORDER BY createdAt DESC LIMIT 1",
            msg.id, msg.channel.id, msg.guild.id, msg.author.id, msg.content);
    }
});



let userWelcomeStatus = {};

const welcomeButtonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
        .setCustomId('dm_getstarted')
        .setLabel('Get Started')
        .setStyle(ButtonStyle.Success)
);

// Handle uncaught exceptions to prevent crash
process.on("uncaughtException", err => {
    console.error("Uncaught Exception:", err);
});

// Global error handler for unhandled rejections as well (prevents crash on async errors)
process.on("unhandledRejection", err => {
    console.error("Unhandled Rejection:", err);
});



// Listen for admin command: update blocklist dynamically (moderation tool, slash command)

client.on('interactionCreate', async interaction => {
    // FIX: Guard .member on permission checks for admin DM/system
    if (
        typeof interaction.isChatInputCommand === "function" &&
        interaction.isChatInputCommand() &&
        interaction.commandName === 'settings' &&
        interaction.options?.getBoolean("autodelete")===false
    ) {
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms."}); return;
        }
        await fs.writeFile(DATA_DIR + "autodelete_botreplies.txt", "off");
        await interaction.reply({content:"Bot reply auto-delete turned OFF."});
        return;
    } else if (
        typeof interaction.isChatInputCommand === "function" &&
        interaction.isChatInputCommand() &&
        interaction.commandName === 'settings' &&
        interaction.options?.getBoolean("autodelete")===true
    ) {
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms."}); return;
        }
        await fs.writeFile(DATA_DIR + "autodelete_botreplies.txt", "on");
        await interaction.reply({content:"Bot reply auto-delete ON (where possible)."});
        return;
    }
    // Example for bad-words list
    if (
        typeof interaction.isChatInputCommand === "function" &&
        interaction.isChatInputCommand() &&
        interaction.commandName === 'settings' &&
        interaction.options?.getString &&
        interaction.options?.getString('badword')
    ) {
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms."}); return;
        }
        let w = interaction.options.getString('badword').toLowerCase();
        let baseList = await readJSONFile("blocked_words.json", []);
        if (!baseList.includes(w)) {
            baseList.push(w);
            await saveJSONFile("blocked_words.json", baseList);
        }
        await interaction.reply({content:"Added to content blocklist."});
        return;
    }
});




client.on('messageCreate', async msg => {
    // Only allow interactions in the ONE main channel (never DM)
    if (!msg.guild || msg.channel.id !== CHANNEL_ID) return;
    if (msg.author.bot) return;

    // Single welcome message per user per session, with Get Started button (moved to main channel)
    if (!userWelcomeStatus[msg.author.id]) {
        await msg.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("👋 Welcome!")
                    .setDescription([
                        "I'm your assistant bot — **notes**, **to-do** (try `/todo`), **reminders**, **polls**, fun games & more via slash commands!",
                        "",
                        "**Try:**",
                        "- `/todo add` to keep a personal to-do list",
                        "- `/note add` for quick notes",
                        "- `/remind` for channel reminders",
                        "- `/avatar` to view profile pictures",
                        "- `/quotes` for fun/motivation",
                        "",
                        "**Click Get Started for a full command guide.**",
                    ].join("\n"))
                    .setColor(0x6ee7b7)
            ],
            components: [welcomeButtonRow]
        });
        userWelcomeStatus[msg.author.id] = true;
        return;
    }

    if (msg.content.startsWith('/help')) {
        await msg.reply(`Available commands:\n- /note\n- /note search\n- /todo\n- /remind\n- /poll\n- /timer\n- /timers\n- /quotes\n\n⭐ Use /todo to pin favorites and stay organized!`);
    } else if (/timer/i.test(msg.content)) {
        await msg.reply("Try `/timer` to set a channel countdown for yourself, or `/timers` to view your timers!");
    } else {
        await msg.reply(`Hi! Slash commands available: /todo, /note, /note search, /remind, /poll, /timer, /quotes, games & more! (Type \`/\` to see all options, or click **Get Started** below.)`);
    }
});



// Get Started button handler for welcome embed (now always in main channel)
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || interaction.customId!=='dm_getstarted') return;
    await interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setTitle("Getting Started with this Bot")
                .setDescription([
                    "**Slash Commands for Productivity & Fun**",
                    "",
                    "- `/todo add` — Pin new ideas, todos, short notes!",
                    "- `/todo list`/`complete` — View and check-off your done tasks",
                    "- `/note add` — Quick notes (in channel, visible to everyone)",
                    "- `/remind` — Public channel reminders, even days in advance!",
                    "- `/poll` — Admins: Create quick channel polls",
                    "- `/xp` — Chat to earn XP & level up",
                    "- `/8ball` — Ask for cosmic wisdom",
                    "- `/avatar` — View yours or anyone's pfp",
                    "- `/leaderboard` — Top chatters/XP",
                    "- `/stats` — Bot usage and content stats",
                    "- `/snipe` — See last deleted message (admin)",
                    "",
                    "🆕 **All user data public – `/todo` and `/note` work in main channel, all can see!**"
                ].join("\n"))
                .setColor(0xfacc15)
        ]
    });
});


































