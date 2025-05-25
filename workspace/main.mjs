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
    catch { await fs.mkdir(DATA_DIR, { recursive: true }); }
}
await ensureDataDir();

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
)`);
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
            const user = await client.users.fetch(next.userId);
            await user.send(`[⏰ Reminder] ${next.content}`);
            await db.run("DELETE FROM reminders WHERE id = ?", next.id);
        } catch{}
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

// --- Slash commands registration ---
const commands = [
    {
        name: 'note',
        description: 'Add/view personal notes privately.',
        options: [
            { name: 'add', type: 1, description: 'Add a private note', options:[{name:'content',type:3,description:'Your note',required:true}]},
            { name: 'list', type: 1, description: 'View your private notes'}
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
    }
];

const rest = new REST({version: '10'}).setToken(TOKEN);
await rest.put(Routes.applicationGuildCommands((await client.application?.id) || "0", GUILD_ID), {body: commands});

// --- Helper functions ---
function parseTime(s) {
    const m = s.match(/^(\d+)(m|h|d)$/i);
    if (!m) return null;
    const n = Number(m[1]);
    if(m[2]==='m') return n*60*1000;
    if(m[2]==='h') return n*60*60*1000;
    if(m[2]==='d') return n*24*60*60*1000;
    return null;
}
const eightBallResponses = [
    'Yes.', 'No.', 'Maybe.', 'Definitely.', 'Ask again later.', "I don't know.", 'Doubtful.', 'Certainly.', 'Absolutely not.', 'For sure!'
];

// --- Restrict allowed channel for MESSAGE & SLASH --- 
client.on('interactionCreate', async interaction => {
    // Only allow the configured channel for everything except DMs
    if (
        (interaction.channel && interaction.channel.id !== CHANNEL_ID) &&
        interaction.channel.type !== 1 // 1 = DM
    ) {
        await interaction.reply({content: 'You cannot use me here.', ephemeral:true});
        return;
    }

    // --- SLASH: NOTE ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'note') {
        if (interaction.options.getSubcommand() === 'add') {
            const txt = interaction.options.getString('content').substring(0, 500);
            await db.run('INSERT INTO notes(userId, note, timestamp) VALUES (?,?,?)',
                interaction.user.id, txt, Date.now());
            await interaction.reply({content:'📝 Note saved (DM only)!', ephemeral:true});
        } else if (interaction.options.getSubcommand() === 'list') {
            const rows = await db.all('SELECT note, timestamp FROM notes WHERE userId=? ORDER BY id DESC LIMIT 10', interaction.user.id);
            if (rows.length === 0) await interaction.reply({content:"No notes yet.", ephemeral:true});
            else {
                const embed = new EmbedBuilder()
                  .setTitle("Your last 10 notes")
                  .setDescription(rows.map(r => `• ${r.note} _(at <t:${Math.floor(r.timestamp/1000)}:f>)_`).join("\n"))
                  .setColor(0x80ecec);
                await interaction.reply({embeds:[embed], ephemeral:true});
            }
        }
        return;
    }

    // --- SLASH: REMIND ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'remind') {
        const content = interaction.options.getString('content').substring(0,200);
        const delay = parseTime(interaction.options.getString('time'));
        if (!delay) return void interaction.reply({content:"Invalid time. Use e.g. 10m, 2h, 1d", ephemeral:true});
        if (delay > 7*24*60*60*1000) return void interaction.reply({content:"Max is 7d.",ephemeral:true});
        await db.run('INSERT INTO reminders(userId, content, remindAt) VALUES (?,?,?)',
            interaction.user.id, content, Date.now() + delay);
        await interaction.reply({content:`⏰ Reminder set! I will DM you in ${interaction.options.getString('time')}.`, ephemeral:true});
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
        await interaction.reply({content:`⚠️ Warned ${user.tag}`,ephemeral:true});
        try {
            await user.send(`[⚠️ Warning] From admins: ${reason}`);
        } catch{}
        return;
    }
    // --- SLASH: WARNINGS ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'warnings') {
        const tgt = interaction.options.getUser('user');
        const rows = await db.all('SELECT reason, timestamp FROM warnings WHERE userId=? ORDER BY id DESC LIMIT 10', tgt.id);
        if (rows.length === 0) await interaction.reply({content:"No warnings for this user!",ephemeral:true});
        else {
            const embed = new EmbedBuilder()
                .setTitle(`${tgt.tag}'s last 10 warnings`)
                .setDescription(rows.map(r=>`• ${r.reason} _(at <t:${Math.floor(r.timestamp/1000)}:f>)_`).join("\n"))
                .setColor(0xd13a29);
            await interaction.reply({embeds:[embed], ephemeral:true});
        }
        return;
    }
    // --- SLASH: PURGE --- 
    if (interaction.isChatInputCommand() && interaction.commandName === 'purge') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.",ephemeral:true});
            return;
        }
        let n = interaction.options.getInteger('count');
        if (n<1 || n>50) {
            await interaction.reply({content:'Count must be 1-50.',ephemeral:true});
            return;
        }
        const chan = await client.channels.fetch(CHANNEL_ID);
        const msgs = await chan.messages.fetch({limit:Math.min(50,n)});
        await chan.bulkDelete(msgs, true);
        await interaction.reply({content:`🧹 Deleted ${msgs.size} messages.`,ephemeral:true});
        return;
    }
    // --- SLASH: XP ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'xp') {
        const row = await db.get('SELECT xp, level FROM xp WHERE userId=?', interaction.user.id);
        if (!row) await interaction.reply({content:'No XP on record.',ephemeral:true});
        else await interaction.reply({content:`You have ${row.xp} XP at level ${row.level}.`,ephemeral:true});
        return;
    }
    // --- SLASH: LEADERBOARD ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
        const rows = await db.all('SELECT userId, xp, level FROM xp ORDER BY level DESC, xp DESC LIMIT 10');
        if (!rows.length) return void interaction.reply({content:"Leaderboard empty.",ephemeral:true});
        let msg = rows.map((r,i)=>`**#${i+1}: <@${r.userId}> — Level ${r.level} (${r.xp} XP)**`).join('\n');
        await interaction.reply({content:msg,ephemeral:false});
        return;
    }
    // --- SLASH: 8BALL ---
    if (interaction.isChatInputCommand() && interaction.commandName === '8ball') {
        const q = interaction.options.getString('question');
        const reply = eightBallResponses[Math.floor(Math.random()*eightBallResponses.length)];
        await interaction.reply({content:`🎱 *Q: ${q}*\nA: **${reply}**`, ephemeral:false});
        return;
    }
});

// --- XP GAIN SYSTEM ---
client.on('messageCreate', async msg => {
    // Restrict to the one allowed channel (except for DMs)
    if (msg.guild && msg.channel.id !== CHANNEL_ID) return;
    if (msg.author.bot) return;
    // Don't run in DMs except for reminders/notes slash cmds
    // XP, content moderation, games: only in main channel
    if (msg.guild) {
        // XP: 3-10/message, 1 min cooldown
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
                await msg.reply({content:`🌟 You leveled up to ${lvlNow}!`,ephemeral:true});
        }

        // Basic moderation: block bad words
        const badwords = ['badword1','badword2','fuck','shit','bitch','asshole'];
        if (badwords.some(w=>msg.content.toLowerCase().includes(w))) {
            await msg.delete().catch(()=>{});
            await msg.reply({content:"🚫 Message removed for inappropriate language.",ephemeral:true});
            await db.run('INSERT INTO warnings(userId, reason, timestamp) VALUES (?,?,?)',
                msg.author.id, "Inappropriate language", Date.now());
        }
    }
});

// --- Startup reminder boot ---
client.once('ready', () => {
    console.log(`Ready as ${client.user.tag}`);
    scheduleReminders(client);
});

// --- DMs: Accept notes/reminders only
client.on('messageCreate', async msg => {
    if (msg.guild) return; // only DMs
    if (msg.author.bot) return;
    if (msg.content.startsWith('/help')) {
        await msg.reply(`Available commands:\n- /note\n- /remind\nPlease use slash commands.`);
    } else {
        await msg.reply(`Hi! Please use slash commands for notes or reminders.`);
    }
});

// --- Login ---
client.login(TOKEN);
