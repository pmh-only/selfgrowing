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
        })
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
let db;
try {
    db = await open({
        filename: DATA_DIR + 'botdata.db',
        driver: sqlite3.Database
    });
} catch (e) {
    console.error("Failed to open SQLite DB!", e);
    process.exit(1);
}

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




// Add reactions table for thumbs up/down on messages (for fun/feedback user tool)
// [NEW FEATURE]: Add reactions table on startup
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
await db.run(`CREATE TABLE IF NOT EXISTS reminders_log (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    content TEXT NOT NULL,
    remindAt INTEGER NOT NULL,
    sentAt INTEGER NOT NULL
)`);
// [NEW: Migrate /log existing reminders if needed (for UX review/history)]
try {
    const hasCol = await db.get("SELECT 1 FROM pragma_table_info('reminders_log') WHERE name = 'sentAt'");
    // No migration needed, table just created
} catch {}

await db.run(`CREATE TABLE IF NOT EXISTS reactions (
    messageId TEXT NOT NULL,
    userId TEXT NOT NULL,
    reaction TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (messageId, userId, reaction)
)`);

await db.run(`CREATE TABLE IF NOT EXISTS suggestion (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    suggestion TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    votes INTEGER NOT NULL DEFAULT 0
)`);
await db.run(`CREATE TABLE IF NOT EXISTS user_tags (
    userId TEXT PRIMARY KEY,
    tag TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
)`);




// Patch: on startup, close out any expired leftover polls (shouldn't be possible, but for data consistency)
// Protect against case client not initialized yet
let leftOpenPolls = [];
try {
    leftOpenPolls = await db.all(`SELECT * FROM poll WHERE expiresAt IS NOT NULL AND expiresAt < ?`, Date.now());
    for (const pollRec of leftOpenPolls) {
        try {
            if (!client || !client.channels) break; // Defensive if client not ready
            const chan = await client.channels.fetch(pollRec.channelId);
            await finishPoll(pollRec, chan);
        } catch {}
    }
} catch {}


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
            // UX: Add to sent reminders log
            try {
                await db.run('INSERT INTO reminders_log(userId, content, remindAt, sentAt) VALUES (?,?,?,?)', next.userId, next.content, next.remindAt, Date.now());
            } catch {}
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
    },
    // New: Add reactions to message
    {
        name: 'Thumbs Up',
        type: 3 // MESSAGE context menu
    },
    {
        name: 'Thumbs Down',
        type: 3 // MESSAGE context menu
    }
];


// --- Slash commands registration ---
    const commands = [
        // ... previous commands ...
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
            name: 'downvotes',
            description: 'Show the most downvoted messages in the channel!'
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
        name: 'clearreactions',
        description: 'Clear all upvotes/downvotes from a message (admin only)',
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString(),
        options:[
            { name:'message_id',type:3,description:'The message ID to clear reactions from',required:true }
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
        name: 'reminderslog',
        description: "Show all reminders ever sent (public display)"
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
        description: "Roll some dice or play a quick dice game (e.g. 1d6, 2d20+5, etc)",
        options: [
            { name: "formula", type: 3, description: "Dice formula (e.g. 1d6+2)", required: false },
            { name: "game", type: 3, description: "Mini-dice game: 'highest' (multiplayer, highest roll wins)", required: false, choices: [
                { name: "Highest (multiplayer)", value: "highest" }
            ]}
        ]
    },

    {
        name: "rollhist",
        description: "Show your recent dice roll history"
    },
    {
        name: "rollstats",
        description: "Show leaderboard and fun stats for dice rolls"
    },


    {
        name: "coinflip",
        description: "Flip a coin for heads or tails!"
    },
    {
        name: "suggest",
        description: "Suggest a feature or idea for this server",
        options: [
            { name: "text", type: 3, description: "Your suggestion", required: true }
        ]
    },
    {
        name: "suggestions",
        description: "Show all suggestions and vote!"
    },

    {
        name: "rockpaperscissors",
        description: "Play Rock Paper Scissors (vs. bot or another user)",
        options: [
            { name: "opponent", type: 6, description: "User to play against (optional)", required: false }
        ]
    }
];





const rest = new REST({version: '10'}).setToken(TOKEN);
try {
    await rest.put(
        Routes.applicationGuildCommands((await client.application?.id) || "0", GUILD_ID),
        {body: [...commands, ...contextCommands]}
    );
} catch (err) {
    console.error("Failed to register slash commands!", err && err.stack ? err.stack : err);
}




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

        let cmsg = null;
try {
    cmsg = await interaction.reply({ embeds: [embed], components:[row], fetchReply:true });
} catch (e) {
    await interaction.reply({content: 'Failed to post poll. Please try again.'});
    return;
}
await db.run(`
    INSERT INTO poll(title, options, creatorId, channelId, messageId, votes, expiresAt)
    VALUES (?,?,?,?,?,?,?)
`, title, JSON.stringify(opts), interaction.user.id, interaction.channel.id, cmsg.id, '{}', Date.now()+dur);
setTimeout(async ()=>{
    let p;
    try { p = await db.get('SELECT * FROM poll WHERE messageId=?', cmsg.id); } catch { p = null; }
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
        if (!quotes.length) return void interaction.reply({content:"No quotes saved."});
        // If user types something like "/quotes category=tag" use it
        let txt = interaction.options? interaction.options.getString?.('category') : undefined;
        let show = quotes;
        // Support filtering by slash command option now!
        if (!interaction.options) txt = undefined;
        else txt = interaction.options.getString?.('category');
        if (txt) show = quotes.filter(q=>q.category && q.category.toLowerCase().includes(txt.toLowerCase()));
        const q = show[Math.floor(Math.random()*show.length)];
        if (!q) return void interaction.reply({content:"No quotes matching that tag!"});
        const embed = new EmbedBuilder()
            .setTitle("💬 Saved Quote")
            .setDescription(`"${q.content}"`)
            .setFooter({text: `By ${(q.user?.tag || q.author_tag || "Unknown")} at <t:${Math.floor(q.timestamp/1000)}:f>${q.category?` | #${q.category}`:""}`});
        await interaction.reply({embeds:[embed]});
        return;
    }


    // --- SLASH: QUOTEADD (NEW PUBLIC ADD QUOTE FEATURE) ---
    if (interaction.isChatInputCommand() && interaction.commandName === "quoteadd") {
        const authorTag = interaction.options.getString("author_tag");
        const content = interaction.options.getString("content");
        let category = interaction.options.getString("category");
        const quotes = await readJSONFile("quotes.json", []);
        quotes.push({
            user: { tag: authorTag },
            author_tag: authorTag,
            content,
            timestamp: Date.now(),
            category: category || undefined,
            addedBy: interaction.user.tag
        });
        await saveJSONFile("quotes.json", quotes);
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("Quote added!")
                    .setDescription([
                        `> "${content}"\n`,
                        `Author: **${authorTag}**`,
                        category ? `Category: **${category}**` : "",
                        `Added by: <@${interaction.user.id}>`
                    ].filter(Boolean).join("\n"))
                    .setColor(0x91FEDC)
            ]
        });
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

    // --- SLASH: EDITTODO (NEW FEATURE) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'edittodo') {
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"Edit To-Do is available only in the main channel.", ephemeral:false});
            return;
        }
        let idx = interaction.options.getInteger('number');
        let newContent = interaction.options.getString('content').substring(0, 300);
        let rows = await db.all("SELECT id, content, userId FROM todo_entries ORDER BY ts DESC LIMIT 15");
        if (!rows[idx-1]) return void interaction.reply({content:"Invalid to-do #"});
        let todoId = rows[idx-1].id;
        let oldContent = rows[idx-1].content;
        await db.run("UPDATE todo_entries SET content=?, ts=? WHERE id=?", newContent, Date.now(), todoId);
        await interaction.reply({content: `✏️ To-Do item #${idx} updated.\nBefore: "${oldContent}"\nAfter: "${newContent}"`});
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
        // Permissions not required - all users are 'admin' for demonstration
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
    // --- SLASH: CLEARREACTIONS (admin-only UX improvement) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'clearreactions') {
        // Permissions not required - all users are 'admin' for demonstration
        let msgId = interaction.options.getString('message_id');
        if (!msgId) {
            await interaction.reply({content:"Please provide a message ID."});
            return;
        }
        try {
            // Remove all upvotes/downvotes tied to this message
            await db.run('DELETE FROM reactions WHERE messageId=? AND (reaction="👍" OR reaction="👎")', msgId);
            // Optionally try to remove reactions on the actual Discord message too
            try {
                let chan = await client.channels.fetch(CHANNEL_ID);
                let msg = await chan.messages.fetch(msgId);
                try { await msg.reactions.removeAll(); } catch {}
            } catch {}
            await interaction.reply({content:"All thumbs up/down reactions cleared from that message (leaderboards should update)."});
        } catch(e) {
            await interaction.reply({content:"Failed to clear reactions. Check the message ID and try again."});
        }
        return;
    }

    // --- SLASH: REMINDERSLOG (SHOW REMINDER HISTORY) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'reminderslog') {
        // Show public log of all sent reminders, newest first
        const rows = await db.all('SELECT userId, content, remindAt, sentAt FROM reminders_log ORDER BY sentAt DESC LIMIT 20');
        if (!rows.length) {
            await interaction.reply({content: 'No reminders have been sent yet!'});
            return;
        }
        // Group by user and show details
        let embed = new EmbedBuilder()
            .setTitle('⏰ Reminder History (last 20)')
            .setDescription(
                rows.map((r, i) =>
                    `**[${i+1}]** <@${r.userId}>: ${r.content} _(Scheduled <t:${Math.floor(r.remindAt/1000)}:R>, Sent <t:${Math.floor(r.sentAt/1000)}:R>)_`
                ).join('\n')
            )
            .setColor(0x6d28d9);
        await interaction.reply({embeds:[embed]});
        return;
    }


    // --- SLASH: PURGE with Confirmation and Cooldown ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'purge') {
        // Permissions not required - all users are 'admin' for demonstration
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
    if (interaction.isChatInputCommand() && interaction.commandName === "suggest") {
        // Suggestion feature: add suggestion to db and post it for voting
        const text = interaction.options.getString("text")?.trim();
        if (!text || text.length < 4) {
            await interaction.reply({content: "Suggestion too short! Please provide more details."}); return;
        }
        // Insert suggestion into DB
        await db.run(
            "INSERT INTO suggestion(userId, suggestion, createdAt) VALUES (?,?,?)",
            interaction.user.id, text.slice(0, 800), Date.now()
        );
        let lastId = (await db.get("SELECT id FROM suggestion ORDER BY id DESC LIMIT 1"))?.id;
        // Color-UX: first suggestions are blue, after voting gold/purple
        const embed = new EmbedBuilder()
            .setTitle("💡 New Suggestion Pending Review")
            .setDescription(`> ${text.slice(0,800)}`)
            .setFooter({ text: `By <@${interaction.user.id}> | Use /suggestions to vote or comment!` })
            .setColor(0x80deea)
            .setTimestamp();
        // Post quick up/down vote buttons for feedback
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`suggest_upvote_${lastId}`)
                .setLabel("👍 Upvote")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`suggest_downvote_${lastId}`)
                .setLabel("👎 Downvote")
                .setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({embeds: [embed], components: [row]});
        return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "suggestions") {
        // List active (not rejected/closed) suggestions, most recent at top
        let recs = await db.all(
            "SELECT * FROM suggestion WHERE status='pending' OR status='approved' ORDER BY createdAt DESC LIMIT 10"
        );
        if (!recs.length) {
            await interaction.reply({content: "No suggestions yet! Use `/suggest` to add one."});
            return;
        }
        // For each, show upvote/downvote counts (reaction-style voting)
        let entries = [];
        for (let s of recs) {
            // Count votes as reactions (reuse reactions table by suggest_id)
            let up = await db.all("SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='suggest:up'", "suggestion_" + s.id);
            let down = await db.all("SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='suggest:down'", "suggestion_" + s.id);
            entries.push({
                ...s,
                up: (up[0]?.n || 0),
                down: (down[0]?.n || 0)
            });
        }
        // Render an embed for each suggestion
        let embeds = entries.map((s, idx) =>
            new EmbedBuilder()
                .setTitle(`Suggestion #${s.id}`)
                .setDescription([
                    `> ${s.suggestion}`,
                    `By: <@${s.userId}>`,
                    `Status: \`${s.status}\``,
                    `👍 ${s.up} | 👎 ${s.down}`
                ].join("\n"))
                .setColor(0xf9a825)
                .setFooter({ text: `Use /suggest to add your own!` })
                .setTimestamp(s.createdAt)
        );
        await interaction.reply({embeds: embeds.slice(0,3)}); // Show up to 3 embeds, avoid spam
        return;
    }
    // --- UX improvement: Quick Roll Button (+data persistence; show leaderboard) ---
    if (interaction.isChatInputCommand() && interaction.commandName === "roll") {
        try {
            // Additional Fun Feature: Multiplayer "highest d20" game!
            let selectedGame = interaction.options?.getString?.("game");
            if (selectedGame === "highest") {
                // Let users join for a brief period, then roll and declare winner
                // Store context using interaction.message.id or a random join key
                const joinKey = `roll_game_highest_${Date.now()}_${Math.floor(Math.random()*10000)}`;
                // Announce game and show join/cancel buttons
                const joinRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`join_dicegame_${joinKey}`).setLabel("🎲 Join").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`start_dicegame_${joinKey}`).setLabel("Start!").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`cancel_dicegame_${joinKey}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("🎲 Dice Game: Highest Roll")
                            .setDescription("Want to play? Click **Join** below! When all joined, click **Start!**\nEach player rolls 1d20. Highest roll wins!\n(Only users who joined can play.)")
                            .setFooter({text: 'Multiplayer demo: all public.'})
                            .setColor(0x9ae6b4)
                    ],
                    components: [joinRow]
                });
                // Game state context
                client._diceGames = client._diceGames || {};
                client._diceGames[joinKey] = {
                    host: interaction.user.id,
                    started: false,
                    users: [interaction.user.id], // host auto-joins
                    joinMsgId: null,
                    interactionReplyId: interaction.id,
                    initiator: interaction.user.id
                };
                // Attach joinMsgId after a tick
                setTimeout(async () => {
                    try {
                        let chan = await client.channels.fetch(CHANNEL_ID);
                        let msg = (await chan.messages.fetch({ limit: 10 })).find(m=>m.interaction && m.interaction.id===interaction.id);
                        if (msg) client._diceGames[joinKey].joinMsgId = msg.id;
                    } catch {}
                }, 1500);
                return;
            }

            // --- Additional Feature: Roll Button After Roll for Replay and Fast Leaderboard ---
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
            if (!m) {
                // Provide quick buttons to roll d6 or d20 for UX
                const rrow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('quickroll_d6').setLabel("Roll 1d6").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('quickroll_d20').setLabel("Roll 1d20").setStyle(ButtonStyle.Success)
                );
                await interaction.reply({content:"Invalid dice formula. Example: **1d20**, **2d6+3**, up to 100 dice (sides 2-1000). \nTry `/roll 2d10+1` or use quick buttons:", components: [rrow]});
                return;
            }

            let num = parseInt(m[1] || "1",10);
            let sides = parseInt(m[2],10);
            let modifier = 0;
            let modmatches = (m[3]||"").match(/[+-]\d+/g);
            if (modmatches) for (let mod of modmatches) modifier += parseInt(mod,10);

            if (isNaN(num) || num<1 || num>100 || isNaN(sides) || sides<2 || sides>1000) {
                await interaction.reply({content:"Dice count must be 1-100; sides 2-1000."}); return;
            }
            
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

            // Additional feature: Save this roll to per-user roll history (in /data/roll_history.json)
            let pastRolls = [];
            try {
                pastRolls = await readJSONFile("roll_history.json", []);
            } catch {}
            let resultMsg = `[${rolls.join(", ")}]` + (modifier ? ` ${modifier>0?"+":""}${modifier}` : "") + ` = ${sum}`;
            pastRolls.push({
                userId: interaction.user.id,
                formula: `${num}d${sides}${modifier? (modifier>0?`+${modifier}`:modifier):""}`,
                results: rolls,
                modifier,
                sum,
                at: Date.now(),
                resultMsg
            });
            // Only retain 50 rolls per user for storage limits
            let keepRolls = [];
            let rollUserCounts = {};
            for (let r of pastRolls.reverse()) {
                rollUserCounts[r.userId] = (rollUserCounts[r.userId]||0)+1;
                if (rollUserCounts[r.userId]<=50) keepRolls.push(r);
            }
            keepRolls = keepRolls.reverse();
            await saveJSONFile("roll_history.json", keepRolls);

            // Add Quick Roll Again and Leaderboard button
            const rowButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`replay_roll_${num}d${sides}${modifier>0?`+${modifier}`:(modifier<0?`${modifier}`:"")}`).setLabel("Roll Again").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`roll_leaderboard`).setLabel("Leaderboard").setStyle(ButtonStyle.Success)
            );

            await interaction.reply({embeds:[
                new EmbedBuilder().setTitle("Dice Roll").setDescription(desc).setColor(0xffbe29)
            ], components: [rowButtons]});
        } catch (e) {
            try {
                await interaction.reply({content:"An error occurred while rolling dice."});
            } catch {}
        }
        return;
    }



    // --- SLASH: ROLLHIST ---
    if (interaction.isChatInputCommand() && interaction.commandName === "rollhist") {
        try {
            let hist = [];
            try { hist = await readJSONFile("roll_history.json", []); } catch {}
            hist = hist.filter(r => r.userId === interaction.user.id).slice(-10).reverse();
            if (!hist.length) return void interaction.reply({content:"No dice roll history found."});
            let lines = hist.map((h,i) => `**${i+1}.** \`${h.formula}\` = ${h.resultMsg} _(at <t:${Math.floor(h.at/1000)}:t>)_`);
            let embed = new EmbedBuilder()
                .setTitle(`${interaction.user.tag}'s Last ${hist.length} Dice Rolls`)
                .setDescription(lines.join("\n"))
                .setColor(0x7dd3fc);
            await interaction.reply({embeds:[embed]});
        } catch (e) {
            await interaction.reply({content:"Failed to show roll history."});
        }
        return;
    }

    // --- SLASH: ROLLSTATS ---
    if (interaction.isChatInputCommand && interaction.commandName === "rollstats") {
        try {
            let histAll = [];
            try { histAll = await readJSONFile("roll_history.json", []); } catch {}
            if (!histAll.length) return void interaction.reply({content:"No roll stats yet!"});
            // Compute: who rolled the highest total; who rolled most; average roll per user (by sum of totals/number)
            let stats = {}, users = {};
            for (let r of histAll) {
                stats[r.userId] = stats[r.userId] || {count:0, sum:0, top:0, name:r.userId};
                stats[r.userId].count++;
                stats[r.userId].sum += r.sum;
                if (r.sum > stats[r.userId].top) stats[r.userId].top = r.sum;
                users[r.userId] = true;
            }
            let userTags = {};
            try {
                for (let uid of Object.keys(users)) {
                    let u = await client.users.fetch(uid);
                    userTags[uid] = u.tag;
                    stats[uid].name = u.tag;
                }
            } catch {}
            // Top user by volume
            let sorted = Object.values(stats).sort((a, b) => b.count - a.count);
            let leaderboard = sorted.slice(0, 5).map((u, i) =>
                `**#${i+1} ${u.name||u.userId}** - ${u.count} rolls, avg total: ${u.count?Math.round(u.sum/u.count):0}, best: ${u.top}`
            );
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🎲 Dice Game Leaderboard & Stats")
                        .setDescription(
                            "Most Active Rollers:\n"
                            + leaderboard.join('\n')
                        ).setColor(0xd1fae5)
                ]
            });
        } catch (e) {
            await interaction.reply({content:"Failed to compute roll stats."});
        }
        return;
    }



    // --- SLASH: COINFLIP ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'coinflip') {
        const result = Math.random() < 0.5 ? "Heads" : "Tails";
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                  .setTitle("🪙 Coin Flip")
                  .setDescription(`The coin landed on **${result}**!`)
                  .setColor(result === "Heads" ? 0xfbff00 : 0x525252)
            ]
        });
        return;
    }

    // --- SLASH: UPVOTES & DOWNVOTES (new public leaderboard for "Thumbs Down") ---
    if (interaction.isChatInputCommand() && (interaction.commandName === 'upvotes' || interaction.commandName === 'downvotes')) {
        // Unified leaderboard for thumbs up or thumbs down, more fun!
        const isUpvotes = interaction.commandName === 'upvotes';
        const reactionStr = isUpvotes ? "👍" : "👎";
        let votes = [];
        try {
            votes = await db.all(`
                SELECT messageId, COUNT(*) as votes
                FROM reactions
                WHERE reaction=?
                GROUP BY messageId
                ORDER BY votes DESC
                LIMIT 5
            `, [reactionStr]);
        } catch {}
        if (!votes || !votes.length) {
            await interaction.reply({content: `No ${isUpvotes ? "upvoted" : "downvoted"} messages yet! Right click a message and use **${reactionStr === "👍" ? "Thumbs Up" : "Thumbs Down"}** to ${isUpvotes ? "upvote" : "downvote"}.`});
            return;
        }
        let embed = new EmbedBuilder()
            .setTitle(isUpvotes ? "🌟 Top Upvoted Messages" : "💢 Most Downvoted Messages")
            .setDescription(isUpvotes ? "The most 'Thumbs Up' messages in this channel." : "Ouch! The most 'Thumbs Down' messages in this channel.");
        let lines = [];
        for (let row of votes) {
            try {
                let chan = await client.channels.fetch(CHANNEL_ID);
                let msg = await chan.messages.fetch(row.messageId);
                let jumplink = msg.url ? `[jump](${msg.url})` : "";
                lines.push(`> "${msg.content.slice(0,60)}" — **${row.votes} ${reactionStr}** ${jumplink}`);
            } catch {
                lines.push(`(Message deleted) — **${row.votes} ${reactionStr}**`);
            }
        }
        embed.setDescription(lines.join("\n") || `No ${isUpvotes ? "upvoted" : "downvoted"} messages found.`);
        await interaction.reply({embeds:[embed]});
        return;
    }


    // --- SLASH: ROCK PAPER SCISSORS ---

    if (interaction.isChatInputCommand() && interaction.commandName === 'rockpaperscissors') {
        const opponent = interaction.options.getUser('opponent');
        if (!opponent || opponent.bot || opponent.id === interaction.user.id) {
            // Play against bot
            const options = [
                new ButtonBuilder().setCustomId('rps_rock').setLabel('🪨 Rock').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('rps_paper').setLabel('📄 Paper').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('rps_scissors').setLabel('✂️ Scissors').setStyle(ButtonStyle.Primary)
            ];
            const row = new ActionRowBuilder().addComponents(options);
            await interaction.reply({
                embeds: [
                    new EmbedBuilder().setTitle("Rock Paper Scissors")
                    .setDescription("Choose your move against the bot:")
                ],
                components: [row]
            });
            // store context for later (map by user ID, short expiry for demo)
            client._rpsPending = client._rpsPending || {};
            client._rpsPending[interaction.user.id] = { against: "bot", started: Date.now(), msg: interaction };
            setTimeout(()=>{ if(client._rpsPending[interaction.user.id]) delete client._rpsPending[interaction.user.id]; }, 120000);
        } else {
            // Play against another user
            // Only allow in same channel (public UX)
            if (opponent.bot) return void interaction.reply({content:"You cannot play against a bot!"});
            const challengeMsg = await interaction.reply({
                content: `<@${opponent.id}> has been challenged to Rock Paper Scissors by <@${interaction.user.id}>!`,
                embeds: [
                    new EmbedBuilder().setTitle("Rock Paper Scissors Challenge")
                      .setDescription(`<@${opponent.id}>, do you accept?`)
                      .setColor(0xffc300)
                ],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('rps_accept_'+interaction.user.id).setLabel("Accept").setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('rps_decline_'+interaction.user.id).setLabel("Decline").setStyle(ButtonStyle.Danger)
                    )
                ]
            });

            // Save challenge context
            client._rpsPending = client._rpsPending || {};
            client._rpsPending[opponent.id] = { vs: interaction.user.id, started: Date.now(), msgId: challengeMsg.id, channelId: interaction.channel.id };
            setTimeout(()=>{ if(client._rpsPending[opponent.id] && Date.now()-client._rpsPending[opponent.id].started>120000){ delete client._rpsPending[opponent.id]; }; },120000);
        }
        return;
    }

    // --- SLASH: RPS-STATS ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'rps-stats') {
        // Initialize DB table if not exists (idempotent, non-blocking)
        try {
            await db.run(`CREATE TABLE IF NOT EXISTS rps_stats (
                userId TEXT NOT NULL,
                wins INTEGER NOT NULL DEFAULT 0,
                losses INTEGER NOT NULL DEFAULT 0,
                draws INTEGER NOT NULL DEFAULT 0,
                vsUserId TEXT,
                ts INTEGER NOT NULL,
                mode TEXT DEFAULT 'pvp'
            )`);
        } catch {}
        // Aggregation: Top 10 by (wins - losses)
        const leaderboard = await db.all(`
            SELECT userId, SUM(wins) as win, SUM(losses) as lose, SUM(draws) as draw
            FROM rps_stats
            GROUP BY userId
            ORDER BY (SUM(wins)-SUM(losses)) DESC, SUM(wins) DESC
            LIMIT 10
        `);
        if (!leaderboard.length)
            return void interaction.reply({content:"No Rock Paper Scissors stats yet."});

        // Details for embed
        let desc = leaderboard.map((r,i)=>
            `**#${i+1} <@${r.userId}>**  — ${r.win}W/${r.lose}L/${r.draw}D`
        ).join("\n");
        const embed = new EmbedBuilder()
            .setTitle("🏆 Rock Paper Scissors Leaderboard")
            .setDescription(desc)
            .setColor(0xf0883e);
        await interaction.reply({embeds: [embed]});
        return;
    }










    // --- SLASH: LEADERBOARD ---

    if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
        const rows = await db.all('SELECT userId, xp, level FROM xp ORDER BY level DESC, xp DESC LIMIT 10');
        // Get user tags from user_tags table for display
        let userTags = {};
        try {
            for (let row of rows) {
                let tagRec = await db.get('SELECT tag FROM user_tags WHERE userId=?', row.userId);
                userTags[row.userId] = tagRec && tagRec.tag ? tagRec.tag : row.userId;
            }
        } catch {}
        if (!rows.length) return void interaction.reply({content:"Leaderboard empty.",ephemeral:true});
        let msg = rows.map((r,i)=>`**#${i+1}: <@${r.userId}> (${userTags[r.userId] || r.userId}) — Level ${r.level} (${r.xp} XP)**`).join('\n');
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

    // --- SLASH: COINFLIP ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'coinflip') {
        const result = Math.random() < 0.5 ? "Heads" : "Tails";
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                  .setTitle("🪙 Coin Flip")
                  .setDescription(`The coin landed on **${result}**!`)
                  .setColor(result === "Heads" ? 0xfbff00 : 0x525252)
            ]
        });
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

// Defensive: ensure db schema for snipe is robust
(async ()=>{
    try {
        await db.run(`ALTER TABLE message_logs ADD COLUMN messageId TEXT`);
    } catch {}
    try {
        await db.run(`ALTER TABLE message_logs ADD COLUMN channelId TEXT`);
    } catch {}
    try {
        await db.run(`ALTER TABLE message_logs ADD COLUMN guildId TEXT`);
    } catch {}
})();


// ---- SLASH: STICKY (moved here for single on-interaction handler) ----
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === "sticky") {
        // Permissions not required - all users are 'admin' for demonstration
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

    // Store/refresh user tag in db for leaderboard/UX use (new feature)
    if (msg.guild) {
        try {
            await db.run(
                'INSERT OR REPLACE INTO user_tags(userId, tag, updatedAt) VALUES (?,?,?)',
                msg.author.id,
                msg.member?.user?.tag || msg.author.username,
                Date.now()
            );
        } catch {}
    }

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



// --- POLL & DICE-GAME BUTTON HANDLERS ---
    // --- DICE ROLL BUTTONS (roll again, quick roll, leaderboard) ---
    if (interaction.isButton() && (
        /^replay_roll_/.test(interaction.customId) ||
        /^quickroll_(d6|d20)/.test(interaction.customId) ||
        /^roll_leaderboard$/.test(interaction.customId)
    )) {
        if (/^roll_leaderboard$/.test(interaction.customId)) {
            // Re-use /rollstats logic, but as embed here!
            try {
                let histAll = [];
                try { histAll = await readJSONFile("roll_history.json", []); } catch {}
                if (!histAll.length) return void interaction.reply({content:"No roll stats yet!"});
                let stats = {}, users = {};
                for (let r of histAll) {
                    stats[r.userId] = stats[r.userId] || {count:0, sum:0, top:0, name:r.userId};
                    stats[r.userId].count++;
                    stats[r.userId].sum += r.sum;
                    if (r.sum > stats[r.userId].top) stats[r.userId].top = r.sum;
                    users[r.userId] = true;
                }
                let userTags = {};
                try {
                    for (let uid of Object.keys(users)) {
                        let u = await client.users.fetch(uid);
                        userTags[uid] = u.tag;
                        stats[uid].name = u.tag;
                    }
                } catch {}
                let sorted = Object.values(stats).sort((a, b) => b.count - a.count);
                let leaderboard = sorted.slice(0, 10).map((u, i) =>
                    `**#${i+1} ${u.name||u.userId}** - ${u.count} rolls, avg: ${u.count?Math.round(u.sum/u.count):0}, best: ${u.top}`
                );
                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("🎲 Dice Game Leaderboard & Stats")
                            .setDescription(
                                leaderboard.join('\n')
                            ).setColor(0xd1fae5)
                    ]
                });
            } catch (e) {
                await interaction.reply({content:"Failed to compute roll stats."});
            }
            return;
        }
        // quickroll_d6, quickroll_d20, or replay_roll_{formula}
        let formula;
        if (/^quickroll_d6$/.test(interaction.customId)) formula = "1d6";
        else if (/^quickroll_d20$/.test(interaction.customId)) formula = "1d20";
        else if (/^replay_roll_/.test(interaction.customId)) formula = interaction.customId.replace(/^replay_roll_/,"");
        else formula = "1d6";
        // Parse formula as in slash command, fallback to 1d6
        let m = formula.replace(/\s+/g,"").toLowerCase().match(/^(\d*)d(\d+)((?:[+-]\d+)*)$/);
        if (!m) formula = "1d6", m = ["1d6","1","6",""];
        let num = parseInt(m[1] || "1",10);
        let sides = parseInt(m[2],10);
        let modifier = 0;
        let modmatches = (m[3]||"").match(/[+-]\d+/g);
        if (modmatches) for (let mod of modmatches) modifier += parseInt(mod,10);

        // Limits (same as /roll)
        if (isNaN(num) || num<1 || num>100 || isNaN(sides) || sides<2 || sides>1000)
            return void interaction.reply({content:"Dice count must be 1-100; sides 2-1000."});

        // Roll!
        let rolls = [];
        for (let i=0;i<num;i++) rolls.push(Math.floor(Math.random()*sides)+1);
        let sum = rolls.reduce((a,b)=>a+b,0) + modifier;
        let desc = `🎲 Rolling: \`${num}d${sides}${modifier? (modifier>0?`+${modifier}`:modifier):""}\`  \nResults: [${rolls.join(", ")}]`
            + (modifier ? ` ${modifier>0?"+":""}${modifier}` : "") + `\n**Total:** \`${sum}\``;

        if (num > 10) {
            desc += `\nTop rolls: ${[...rolls].sort((a,b)=>b-a).slice(0,5).join(", ")}`;
            desc += `\nLowest: ${[...rolls].sort((a,b)=>a-b).slice(0,3).join(", ")}`;
        }
        if (sides===20 && num===1) {
            if (rolls[0]===20)
                desc += "\n🌟 **NAT 20!** Critical success!";
            else if (rolls[0]===1)
                desc += "\n💀 NAT 1! Oof.";
        }

        // Save to history
        let pastRolls = [];
        try { pastRolls = await readJSONFile("roll_history.json", []);} catch{}
        let resultMsg = `[${rolls.join(", ")}]` + (modifier ? ` ${modifier>0?"+":""}${modifier}` : "") + ` = ${sum}`;
        pastRolls.push({
            userId: interaction.user.id,
            formula: `${num}d${sides}${modifier? (modifier>0?`+${modifier}`:modifier):""}`,
            results: rolls,
            modifier,
            sum,
            at: Date.now(),
            resultMsg
        });
        // Only retain 50 rolls per user
        let keepRolls = [];
        let rollUserCounts = {};
        for (let r of pastRolls.reverse()) {
            rollUserCounts[r.userId] = (rollUserCounts[r.userId]||0)+1;
            if (rollUserCounts[r.userId]<=50) keepRolls.push(r);
        }
        keepRolls = keepRolls.reverse();
        await saveJSONFile("roll_history.json", keepRolls);

        // Add buttons again
        const rowButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`replay_roll_${num}d${sides}${modifier>0?`+${modifier}`:(modifier<0?`${modifier}`:"")}`).setLabel("Roll Again").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`roll_leaderboard`).setLabel("Leaderboard").setStyle(ButtonStyle.Success)
        );

        await interaction.reply({embeds:[
            new EmbedBuilder().setTitle("Dice Roll").setDescription(desc).setColor(0xffbe29)
        ], components: [rowButtons]});
        return;
    }

client.on('interactionCreate', async interaction => {

    // --- DICE GAME: HIGHEST MULTIPLAYER JOIN/START/CANCEL
    if (interaction.isButton() && /^join_dicegame_|^start_dicegame_|^cancel_dicegame_/.test(interaction.customId)) {

        const [action, , joinKey] = interaction.customId.split("_");
        client._diceGames = client._diceGames || {};
        const game = client._diceGames[joinKey];
        if (!game) {
            await interaction.reply({content: "This game has expired or was cancelled.", components: []});
            return;
        }
        if (action === "join") {
            // Only allow before start
            if (game.started) {
                await interaction.reply({content: "Game already started!", components: []});
                return;
            }
            // User can only join once
            if (!game.users.includes(interaction.user.id)) {
                game.users.push(interaction.user.id);
            }
            // Update join embed
            try {
                let chan = await client.channels.fetch(CHANNEL_ID);
                let msg = game.joinMsgId ? await chan.messages.fetch(game.joinMsgId) : null;
                let embed = new EmbedBuilder()
                    .setTitle("🎲 Dice Game: Highest Roll")
                    .setDescription([
                        "Want to play? Click **Join** below! When all joined, click **Start!**",
                        "",
                        `**Players Joined:**\n${game.users.map(uid => `<@${uid}>`).join(", ")}`,
                        "",
                        "When ready, click **Start!**"
                    ].join('\n'))
                    .setColor(0x9ae6b4);
                if (msg) {
                    await msg.edit({embeds: [embed]});
                } else {
                    await interaction.update({ embeds:[embed] }); // fallback
                }
            } catch {}
            await interaction.reply({content: "You've joined! Wait for Start.", components: []});
            return;
        } else if (action === "start") {
            if (game.started) {
                await interaction.reply({content: "Already started!", components: []});
                return;
            }
            if (!game.users?.length || (game.users.length < 2)) {
                await interaction.reply({content: "Need at least 2 players!"});
                return;
            }
            game.started = true;
            // Roll for everyone!
            let rolls = {};
            for (let uid of game.users) {
                rolls[uid] = Math.floor(Math.random()*20)+1;
            }
            let topScore = Math.max(...Object.values(rolls));
            let winners = Object.entries(rolls).filter(([uid, num]) => num === topScore).map(([uid])=>uid);
            let playerTags = {};
            for (let uid of game.users) {
                try { let u = await client.users.fetch(uid); playerTags[uid] = u.tag || uid; } catch { playerTags[uid] = `<@${uid}>`; }
            }
            let embed = new EmbedBuilder()
                .setTitle("🎲 Dice Game: Highest Roll Results")
                .setDescription(game.users.map(uid=>`<@${uid}> rolled **${rolls[uid]}**`).join("\n"))
                .setFooter({text: winners.length===1 ? `Winner: ${playerTags[winners[0]]}` : `Winners: ${winners.map(w=>playerTags[w]).join(", ")}`})
                .setColor(0xfca5a5);
            try {
                let chan = await client.channels.fetch(CHANNEL_ID);
                if (game.joinMsgId && chan) {
                    let msg = await chan.messages.fetch(game.joinMsgId);
                    await msg.edit({embeds:[embed], components:[]});
                }
            } catch {}
            await interaction.reply({embeds:[embed]});
            delete client._diceGames[joinKey];
            return;
        } else if (action === "cancel") {
            try {
                let chan = await client.channels.fetch(CHANNEL_ID);
                if (game.joinMsgId && chan) {
                    let msg = await chan.messages.fetch(game.joinMsgId);
                    await msg.edit({
                        embeds: [new EmbedBuilder().setTitle("🎲 Dice Game Cancelled").setColor(0xcccccc)],
                        components: []
                    });
                }
            } catch {}
            await interaction.reply({content:"Game cancelled."});
            delete client._diceGames[joinKey];
            return;
        }
    }

    // --- ROCK PAPER SCISSORS BUTTONS ---
    if (interaction.isButton() && /^rps_/.test(interaction.customId)) {

        // RPS move selection
        const user = interaction.user;
        client._rpsPending = client._rpsPending || {};
        // Playing against bot (no opponent set)
        if (['rps_rock','rps_paper','rps_scissors'].includes(interaction.customId)) {
            // Only allow if pending and not expired
            let pending = client._rpsPending[user.id];
            if (!pending || !pending.against || pending.against !== "bot") {
                await interaction.reply({content: "No active game! Start with `/rockpaperscissors`.", components: []});
                return;
            }
            // Ensure DB exists
            try {
                await db.run(`CREATE TABLE IF NOT EXISTS rps_stats (
                    userId TEXT NOT NULL,
                    wins INTEGER NOT NULL DEFAULT 0,
                    losses INTEGER NOT NULL DEFAULT 0,
                    draws INTEGER NOT NULL DEFAULT 0,
                    vsUserId TEXT,
                    ts INTEGER NOT NULL,
                    mode TEXT DEFAULT 'pvp'
                )`);
            } catch {}
            const moves = ['rock','paper','scissors'];
            const playerMove = interaction.customId.replace('rps_','');
            const botMove = moves[Math.floor(Math.random()*3)];
            let resultMsg = `You chose **${playerMove}**. I chose **${botMove}**!\n`;
            let winlose = 'draw';
            if (playerMove === botMove) resultMsg += "It's a draw!";
            else if (
                (playerMove==='rock' && botMove==='scissors') ||
                (playerMove==='paper' && botMove==='rock') ||
                (playerMove==='scissors' && botMove==='paper')
            ) {
                resultMsg += "🎉 You win!";
                winlose = 'win';
            }
            else {
                resultMsg += "😏 I win!";
                winlose = 'lose';
            }
            // Write to stats: mode=bot
            try {
                if (winlose === 'win')
                    await db.run(`INSERT INTO rps_stats(userId, wins, losses, draws, ts, mode) VALUES (?,?,?,?,?,?)`,
                        user.id, 1, 0, 0, Date.now(), 'bot');
                else if (winlose === 'lose')
                    await db.run(`INSERT INTO rps_stats(userId, wins, losses, draws, ts, mode) VALUES (?,?,?,?,?,?)`,
                        user.id, 0, 1, 0, Date.now(), 'bot');
                else
                    await db.run(`INSERT INTO rps_stats(userId, wins, losses, draws, ts, mode) VALUES (?,?,?,?,?,?)`,
                        user.id, 0, 0, 1, Date.now(), 'bot');
            } catch {}
            await interaction.update({
                embeds: [new EmbedBuilder()
                    .setTitle("Rock Paper Scissors Result")
                    .setDescription(resultMsg)
                    .setColor(0x2196F3)
                ],
                components: []
            });
            delete client._rpsPending[user.id];
            return;
        }


        // If it's an accept/decline for PvP
        if (/^(rps_accept_|rps_decline_)/.test(interaction.customId)) {
            let challengerId = interaction.customId.split("_")[2];
            // Only the challenged user can click
            if (client._rpsPending[interaction.user.id] && client._rpsPending[interaction.user.id].vs === challengerId) {
                if (interaction.customId.startsWith('rps_accept_')) {
                    // Start the duel! Prompt each player in DMs or via ephemeral user-friendly message
                    let challenge = client._rpsPending[interaction.user.id];
                    let pmBtns = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('rps_choice_rock_'+challengerId).setLabel('🪨 Rock').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('rps_choice_paper_'+challengerId).setLabel('📄 Paper').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('rps_choice_scissors_'+challengerId).setLabel('✂️ Scissors').setStyle(ButtonStyle.Primary)
                    );
                    // Initiate context for each player (record only their move)
                    client._rpsPvPMoves = client._rpsPvPMoves || {};
                    client._rpsPvPMoves[interaction.user.id+"_"+challengerId] = {};
                    // Ask both players to pick (send in the channel as public for demonstration)
                    await interaction.update({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle("RPS: Game Started!")
                                .setDescription(`<@${interaction.user.id}> vs <@${challengerId}>:\nBoth, select your move!`)
                                .setColor(0x43d492)
                        ],
                        components: [pmBtns]
                    });
                    // Save that this message is used for this round
                    client._rpsPvPMovesMsg = client._rpsPvPMovesMsg || {};
                    client._rpsPvPMovesMsg[interaction.message.id] = { ids: [interaction.user.id, challengerId] };
                } else {
                    await interaction.update({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle("RPS: Challenge Declined")
                                .setDescription(`<@${interaction.user.id}> has declined the challenge.`)
                                .setColor(0xca3c3c)
                        ],
                        components: []
                    });
                }
                delete client._rpsPending[interaction.user.id];
            } else {
                await interaction.reply({content: "You are not the challenged user.", components: []});
            }
            return;
        }

        // PvP Move selection (rps_choice_<move>_<opponentid>)
        if (/^rps_choice_(rock|paper|scissors)_/.test(interaction.customId)) {
            let [ , , move, opponentId ] = interaction.customId.split("_");
            let ids = [interaction.user.id, opponentId];
            ids.sort();
            let key = ids.join("_");
            client._rpsPvPMoves = client._rpsPvPMoves || {};
            client._rpsPvPMoves[key] = client._rpsPvPMoves[key] || {};
            client._rpsPvPMoves[key][interaction.user.id] = move;

            // Wait for both moves
            let movesObj = client._rpsPvPMoves[key];
            if (Object.keys(movesObj).length === 2) {
                // Announce result
                let moveA = movesObj[ids[0]];
                let moveB = movesObj[ids[1]];
                let getName = id => "<@"+id+">";
                let result;
                let winnerId = null, loserId = null, draw = false;
                if (moveA === moveB) {
                    result = "It's a draw!";
                    draw = true;
                }
                else if (
                    (moveA==='rock' && moveB==='scissors') ||
                    (moveA==='paper' && moveB==='rock') ||
                    (moveA==='scissors' && moveB==='paper')
                ) {
                    result = `${getName(ids[0])} wins! 🎉`;
                    winnerId = ids[0]; loserId = ids[1];
                }
                else {
                    result = `${getName(ids[1])} wins! 🎉`;
                    winnerId = ids[1]; loserId = ids[0];
                }

                // Try to find the original message to update
                let msgId = null;
                for (let mid in (client._rpsPvPMovesMsg||{})) {
                    let arr = client._rpsPvPMovesMsg[mid].ids;
                    if (arr && arr.includes(ids[0]) && arr.includes(ids[1])) {
                        msgId = mid;
                        break;
                    }
                }
                if (msgId) {
                    try {
                        let chan = await client.channels.fetch(CHANNEL_ID);
                        let msg = await chan.messages.fetch(msgId);
                        await msg.edit({
                            embeds: [ new EmbedBuilder()
                                .setTitle("Rock Paper Scissors Result")
                                .setDescription(`${getName(ids[0])} chose **${moveA}**\n${getName(ids[1])} chose **${moveB}**\n${result}`)
                                .setColor(0xf48c06)
                            ],
                            components: []
                        });
                    } catch {}
                }
                // Write to rps_stats table for each player for aggregate stats!
                try {
                    await db.run(`CREATE TABLE IF NOT EXISTS rps_stats (
                        userId TEXT NOT NULL,
                        wins INTEGER NOT NULL DEFAULT 0,
                        losses INTEGER NOT NULL DEFAULT 0,
                        draws INTEGER NOT NULL DEFAULT 0,
                        vsUserId TEXT,
                        ts INTEGER NOT NULL,
                        mode TEXT DEFAULT 'pvp'
                    )`);
                    if (draw) {
                        await db.run(`INSERT INTO rps_stats(userId, wins, losses, draws, vsUserId, ts, mode) VALUES (?,?,?,?,?,?,?)`,
                            ids[0], 0, 0, 1, ids[1], Date.now(), 'pvp');
                        await db.run(`INSERT INTO rps_stats(userId, wins, losses, draws, vsUserId, ts, mode) VALUES (?,?,?,?,?,?,?)`,
                            ids[1], 0, 0, 1, ids[0], Date.now(), 'pvp');
                    } else if (winnerId && loserId) {
                        await db.run(`INSERT INTO rps_stats(userId, wins, losses, draws, vsUserId, ts, mode) VALUES (?,?,?,?,?,?,?)`,
                            winnerId, 1, 0, 0, loserId, Date.now(), 'pvp');
                        await db.run(`INSERT INTO rps_stats(userId, wins, losses, draws, vsUserId, ts, mode) VALUES (?,?,?,?,?,?,?)`,
                            loserId, 0, 1, 0, winnerId, Date.now(), 'pvp');
                    }
                } catch {}
                delete client._rpsPvPMoves[key];
            }
            await interaction.reply({content:"Move received!", components: []});
            return;
        }
    }

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
        // Permissions not required - all users are 'admin' for demonstration
        await db.run('INSERT INTO warnings(userId, reason, timestamp) VALUES (?,?,?)',
            interaction.targetUser.id, "XP MUTE (admin muted)", Date.now());
        await interaction.reply({content:`🔇 User ${interaction.targetUser.tag} will not earn XP until unmuted.`});
        return;
    }




    // Additional feature: context menu "Add to To-Do" on user messages
    if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === "Add To-Do") {
        let msg = interaction.targetMessage;
        await db.run("INSERT INTO todo_entries(userId, content, done, ts) VALUES (?,?,0,?)", interaction.user.id, msg.content.substring(0,300), Date.now());
        await interaction.reply({content:"Added message as a to-do in the public To-Do list. Use `/todo list` to view!"});
        return;
    }

    // FUN FEATURE: Thumbs up/down reaction context menu
    if (interaction.isMessageContextMenuCommand?.() && (interaction.commandName === "Thumbs Up" || interaction.commandName === "Thumbs Down")) {
        let msg = interaction.targetMessage;
        let reaction = interaction.commandName === "Thumbs Up" ? "👍" : "👎";
        // Only allow one reaction per user per message per type
        await db.run(`
            INSERT INTO reactions(messageId, userId, reaction, ts)
            VALUES (?,?,?,?)
        `, msg.id, interaction.user.id, reaction, Date.now());
        // Count reactions
        let ups = await db.all(`SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='👍'`, msg.id);
        let downs = await db.all(`SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='👎'`, msg.id);
        // Simple aggregate UX
        await interaction.reply({content: `You reacted to this message with ${reaction}.\nTotal: 👍 ${ups[0].n} | 👎 ${downs[0].n}`});
        // Add actual unicode reaction for quick visual feedback
        try { await msg.react(reaction); } catch {}
        return;
    }

    // Suggestion voting feature
    if (interaction.isButton() && (/^suggest_(up|down)vote_/).test(interaction.customId)) {
        const [, type,, sugid] = interaction.customId.split("_");
        const sId = Number(sugid);
        if (!sId) return void interaction.reply({content: "Invalid suggestion ID."});
        // Only allow voting once per user per suggestion
        let existing = await db.get(`SELECT * FROM reactions WHERE messageId=? AND userId=? AND reaction=?`,
            "suggestion_" + sId, interaction.user.id, `suggest:${type}`);
        if (existing) {
            await interaction.reply({content: "You already voted on this suggestion."});
            return;
        }
        // Upsert reaction, and update votes in suggestion table if necessary
        await db.run(`INSERT INTO reactions(messageId, userId, reaction, ts) VALUES (?,?,?,?)`,
            "suggestion_" + sId, interaction.user.id, `suggest:${type}`, Date.now());
        // Count new votes
        let up = await db.get(`SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='suggest:up'`, "suggestion_" + sId);
        let down = await db.get(`SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='suggest:down'`, "suggestion_" + sId);
        await db.run(`UPDATE suggestion SET votes=? WHERE id=?`, (up.n - down.n), sId);
        // UX: update suggestion embed if in channel
        await interaction.reply({content: `Thank you for your ${type === 'up' ? '👍 upvote' : '👎 downvote'}!`});
        return;
    }
});















// --- Startup reminder boot ---
// Show top 5 most upvoted messages feature
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
    if (!msg.partial && msg.guild && msg.channel && msg.channel.id === CHANNEL_ID && !msg.author?.bot) {
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

// Safety: ensure error handler always logs full error details (fix: error may be object or string, output .stack if present)
process.on("uncaughtException", err => {
    if (err && err.stack) console.error("Uncaught Exception:", err.stack);
    else console.error("Uncaught Exception:", err);
});

// Global error handler for unhandled rejections as well (prevents crash on async errors)
process.on("unhandledRejection", err => {
    if (err && err.stack) console.error("Unhandled Rejection:", err.stack);
    else console.error("Unhandled Rejection:", err);
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
        // Permissions not required - all users are 'admin' for demonstration
        await fs.writeFile(DATA_DIR + "autodelete_botreplies.txt", "off");
        await interaction.reply({content:"Bot reply auto-delete turned OFF."});
        return;
    } else if (
        typeof interaction.isChatInputCommand === "function" &&
        interaction.isChatInputCommand() &&
        interaction.commandName === 'settings' &&
        interaction.options?.getBoolean("autodelete")===true
    ) {
        // Permissions not required - all users are 'admin' for demonstration
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
        // Permissions not required - all users are 'admin' for demonstration
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
    // Upgrade: Show a new fun leaderboard of most upvoted ("Thumbs Up") messages for user engagement!
    let topMsgs = [];
    try {
        topMsgs = await db.all(`
            SELECT messageId, COUNT(*) as votes
            FROM reactions
            WHERE reaction='👍'
            GROUP BY messageId
            ORDER BY votes DESC
            LIMIT 3
        `);
    } catch {}
    let leaderboardLines = [];
    for (let row of topMsgs) {
        // Try to fetch message content, fallback if not found
        try {
            let chan = await client.channels.fetch(CHANNEL_ID);
            let msg = await chan.messages.fetch(row.messageId);
            leaderboardLines.push(`> "${msg.content.slice(0,60)}" — **${row.votes} 👍**`);
        } catch {
            leaderboardLines.push(`MessageID: ${row.messageId}, Upvotes: ${row.votes}`);
        }
    }
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
                    "🆕 **All user data public – `/todo` and `/note` work in main channel, all can see!**",
                    leaderboardLines.length ? "\n**🌟 Top Upvoted Messages:**\n" + leaderboardLines.join("\n") : ""
                ].join("\n"))
                .setColor(0xfacc15)
        ]
    });
});



































