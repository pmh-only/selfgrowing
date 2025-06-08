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
    votes INTEGER NOT NULL DEFAULT 0,
    handled INTEGER NOT NULL DEFAULT 0 -- ADDED FIELD: track "handled" suggestions
)`);
// Additional Feature: Add suggestion auto-tag column for UX (category), migrate existing data if needed
try {
    const cols = await db.all("PRAGMA table_info('suggestion')");
    if (!cols.some(c => c.name === "category")) {
        await db.run("ALTER TABLE suggestion ADD COLUMN category TEXT");
    }
} catch {}


await db.run(`CREATE TABLE IF NOT EXISTS user_tags (
    userId TEXT PRIMARY KEY,
    tag TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
)`);




// Patch: on startup, close out any expired leftover polls (shouldn't be possible, but for data consistency)
// Protect against case client not initialized yet
let leftOpenPolls = [];
/*
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
*/
// Defer closing of expired polls until client is ready (fix: client not defined yet!)
// Moved to client.once('ready') below.



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

// [FEATURE] Create feedback table on startup if it doesn't exist.
await db.run(`CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    upvotes INTEGER NOT NULL DEFAULT 0,
    downvotes INTEGER NOT NULL DEFAULT 0,
    voters TEXT NOT NULL DEFAULT '[]'
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
    // Get next scheduled reminder from single reminders table
    const next = await db.get("SELECT * FROM reminders ORDER BY remindAt ASC LIMIT 1");
    // Get all recurring reminders from file, that are due now or sooner
    let recur = [];
    let dueRecur = [];
    try { recur = await readJSONFile("recurring_reminders.json", []); } catch {}
    const now = Date.now();
    if (recur && recur.length) {
        dueRecur = recur.filter(r => r.nextAt && r.nextAt <= now);
    }

    // Pick which occurs first
    let earliest = null;
    if (next && (!dueRecur.length || next.remindAt < dueRecur[0]?.nextAt)) earliest = { type: "once", item: next };
    else if (dueRecur.length) earliest = { type: "recur", item: dueRecur[0] };
    if (!earliest) {
        // No reminders at all, but may be some in future for recurs
        let futureRecurs = recur.filter(r => r.nextAt && r.nextAt > now);
        let soonestFuture = null;
        if (futureRecurs.length) soonestFuture = futureRecurs.sort((a,b)=>a.nextAt-b.nextAt)[0];
        if (soonestFuture) {
            let wait = Math.max(0, soonestFuture.nextAt - now);
            reminderTimer = setTimeout(()=>scheduleReminders(client), wait);
            return;
        }
        return;
    }
    let wait = 0;
    if (earliest.type === "once") wait = Math.max(0, earliest.item.remindAt - now);
    else if (earliest.type === "recur") wait = Math.max(0, earliest.item.nextAt - now);

    reminderTimer = setTimeout(async () => {
        try {
            const chan = client.channels.cache.get(CHANNEL_ID) || (await client.channels.fetch(CHANNEL_ID));
            if (chan?.isTextBased && chan?.send) {
                let uname;
                try {
                    let userObj = await client.users.fetch(earliest.item.userId);
                    uname = userObj.username;
                } catch { uname = earliest.item.userId; }
                await chan.send(`${uname}: [⏰ Reminder] ${earliest.item.content}`);
            }
            if (earliest.type === "once") {
                await db.run("DELETE FROM reminders WHERE id = ?", earliest.item.id);
                try {
                    await db.run('INSERT INTO reminders_log(userId, content, remindAt, sentAt) VALUES (?,?,?,?)', earliest.item.userId, earliest.item.content, earliest.item.remindAt, Date.now());
                } catch {}
            }
            if (earliest.type === "recur") {
                // Compute next occurrence: add interval to previous nextAt
                let recurs = [];
                try { recurs = await readJSONFile("recurring_reminders.json", []); } catch {}
                // Advance nextAt repeatedly if missed far in past, so if bot restarts after downtime, doesn't send old reminders.
                let thisIdx = recurs.findIndex(r => r.userId===earliest.item.userId && r.content===earliest.item.content && r.intervalMs===earliest.item.intervalMs);
                if (thisIdx !== -1) {
                    // Snap to "now + interval"
                    let newNextAt = recurs[thisIdx].nextAt;
                    while (newNextAt <= Date.now()) newNextAt += recurs[thisIdx].intervalMs;
                    recurs[thisIdx].nextAt = newNextAt;
                    await saveJSONFile("recurring_reminders.json", recurs);
                }
            }
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
    ],
    allowedMentions: { parse: [] } // disables all mentions at client construction/Layer
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
// Node.js fetch (polyfill for joke API)
import fetch from 'node-fetch';

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
    },
    // NEW FEATURE: GG Leaderboard command registration (for right-click)
    {
        name: 'GG Leaderboard',
        type: 2 // USER context, just for fun
    },
    // ADDITIONAL FEATURE: REPORT context menu (message command)
    {
        name: 'Report',
        type: 3 // MESSAGE context menu
    }
];


// --- Slash commands registration ---
    // [FEATURE] Add /feedback and /feedbacklist slash commands for public feedback board.
    const commands = [
        // NEW FEATURE: /remindersclear command for clearing all your reminders
        {
            name: 'archive',
            description: 'Export the last 50 public messages as a text file attachment.'
        },
        {
            name: 'upvotes',
            description: 'Show the most upvoted messages in the channel!'
        },
        {
            name: 'remindersclear',
            description: 'Remove all your pending reminders at once (UX quick clean).'
        },
        // --- [NEW FEATURE] RANDOM USER ---
        {
            name: 'randomuser',
            description: 'Pick a random user from recent participants (fun/randomizer)!'
        },

    // --- ADDITIONAL FEATURE: REPORT from context menu (register missing) ---
    {
        name: 'report',
        description: 'Report a message for review.',
        options: [
            { name: 'message_id', type: 3, description: "Message ID to report", required: true },
            { name: 'reason', type: 3, description: "Reason for reporting", required: true }
        ]
    },
    // --- ADDITIONAL FEATURE: CLEARMESSAGES (Moderation) ---
    {
        name: 'clearmessages',
        description: "Delete a user's last 100 messages in this channel (and log)",
        options: [
            { name: 'target_user', type: 6, description: "User whose messages to delete", required: true }
        ]
    },
    // --- ADDITIONAL FEATURE: PER-USER SETTINGS (Mute XP) ---
    {
        name: "settings_user",
        description: "Configure your personal settings (mute XP, notification preferences, etc).",
        options: [
            { name: "mute_xp", type: 5, description: "Temporarily mute your XP gain", required: false },
            { name: "clear_xp_mute", type: 5, description: "Clear your XP mute if set", required: false }
        ]
    },

    // --- ADDITIONAL FEATURE: MESSAGE ARCHIVE COMMAND ---
    // moved registration up for consistency

    // --- ADDITIONAL FEATURE: REMINDER EXPORT IMPORT ---
    {
        name: "reminderexport",
        description: "Export your reminders as a JSON file."
    },
    {
        name: "reminderimport",
        description: "Import reminders from a JSON text (paste full JSON array).",
        options: [
            { name: "json", type: 3, description: "Reminders JSON from /reminderexport", required: true }
        ]
    },
    // --- ADDITIONAL FEATURE: MESSAGE PINNED LIST SLASH (register missing) ---
    {
        name: "pinned",
        description: "View the last 10 pinned messages (with jump links/note)."
    },
    // ... previous commands ...
    // [NEW FEATURE REGISTER]: /recent for fetching last 10 messages











        // NEW FEATURE: /gg and /ggleaderboard slash commands registration
        {
            name: "gg",
            description: "Show your GG count (earn by writing 'gg' in chat)"
        },
        {
            name: "ggleaderboard",
            description: "Show top GG (👏) senders in this channel!"
        },

    // --- ADDITIONAL FEATURE: REMINDER REMOVE COMMAND ---
    {
        name: 'reminderremove',
        description: 'Remove a pending reminder by its number from your reminder list.',
        options: [
            { name: 'number', type: 4, description: 'Reminder number as seen in /reminders.', required: true }
        ]
    },

    // --- NEW FEATURE: PUBLIC USER REACTION HISTORY (/myreactions) ---
    {
        name: "myreactions",
        description: "Show your last 10 message reactions (public, upvote/downvote/other)."
    },

    // --- ADDITIONAL FEATURE: VIEW REPORTS (MODERATION) ---
    {
        name: "reports",
        description: "Show recent public message reports for moderation review"
    },
    // --- ADDITIONAL FEATURE: PUBLIC WARNING LOG (MODERATION) ---
    {
        name: "warns",
        description: "Show the last 10 warnings issued (public, moderation log)"
    },
    // --- ADDITIONAL FEATURE: MSGSEARCH COMMAND ---
    {
        name: "msgsearch",
        description: "Search recent public messages by keyword.",
        options: [
            { name: "keyword", type: 3, description: "Keyword to search for", required: true }
        ]
    },
    // --- Additional Feature: Public fun fact list/leaderboard command ---
    {
        name: 'funfacts',
        description: 'Show the last few fun facts posted in this channel!'
    },



        {
            name: 'note',
            description: 'Add/view/delete personal notes publicly in channel.',
            options: [
                { name: 'add', type: 1, description: 'Add a public note', options:[{name:'content',type:3,description:'Your note',required:true}]},
                { name: 'list', type: 1, description: 'View recent public notes'},
                { name: 'delete', type: 1, description: 'Delete a note by its number', options: [{name:"number",type:4,description:"Note number from /note list",required:true}]},
                { name: 'pin', type: 1, description: 'Pin a note by its number', options: [{name:"number",type:4,description:"Note # to pin",required:true}]},
                { name: 'pinned', type: 1, description: 'View your pinned notes'},
                { name: 'search', type: 1, description: 'Search public notes', options: [{name:"query",type:3,description:"Search text",required:true}]}
            ]
        },
        {
            name: 'downvotes',
            description: 'Show the most downvoted messages in the channel!'
        },

        // [ADDED: COMMAND REGISTRATION MISSING] Add missing suggesthandle and rps-stats public commands
        {
            name: 'suggesthandle',
            description: 'Admin: Mark a suggestion as handled',
            options: [
                { name: 'suggestion_id', type: 4, description: "Suggestion ID", required: true },
                { name: 'status', type: 3, description: "Status", required: true, choices: [
                    { name: "Approved", value: "approved" },
                    { name: "Rejected", value: "rejected" },
                    { name: "Handled", value: "handled" }
                ]}
            ]
        },
        {
            name: 'rps-stats',
            description: 'Show Rock Paper Scissors leaderboard & stats'
        },
        // --- NEW FEATURE: REGISTER /quotesearch COMMAND FOR PUBLIC QUOTE SEARCH ---
        {
            name: "quotesearch",
            description: "Search public quotes by author (username#tag or part)",
            options: [
                { name: "author", type: 3, description: "Username#tag (or partial)", required: true }
            ]
        },

        // --- NEW FEATURE: FEEDBACK BOARD ---
        {
            name: 'feedback',
            description: "Post public feedback for bot/server (public board, upvote/downvote)",
            options: [
                {
                    name: 'text',
                    type: 3,
                    description: 'Your feedback (bugs, praise, suggestions, etc)',
                    required: true
                }
            ]
        },
        {
            name: 'feedbacklist',
            description: 'Show recent public feedback board for the community'
        },
        // --- NEW MODERATION TOOL: MASS WARN CLEAR ---
        {
            name: 'clearwarnings',
            description: 'Remove all warnings for a user',
            options: [
                { name: 'user', type: 6, description: "User to clear warnings for", required: true }
            ]
        },
        // --- NEW FEATURE: JOKE COMMAND ---
        {
            name: "joke",
            description: "Get a random programming or general joke for fun"
        },
        // --- ADDITIONAL FEATURE: ANNOUNCE COMMAND REGISTRATION ---
        {
            name: "announce",
            description: "Post a public announcement in the main channel",
            options: [
                { name: "title", type: 3, description: "Announcement title", required: true },
                { name: "message", type: 3, description: "Main announcement message", required: true }
            ]
        },
        // --- ADDITIONAL FEATURE: QUOTEADD (register missing) ---
        {
            name: "quoteadd",
            description: "Add a quote to the quote board (author, text, [category]).",
            options: [
                { name: "author_tag", type: 3, description: "Who to credit for this quote (username#tag)", required: true },
                { name: "content", type: 3, description: "The quote or message", required: true },
                { name: "category", type: 3, description: "Optional category/tag" }
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
        description: "Manage a public to-do list in the main channel",
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
            { name:'list', type:1, description:"List the public to-do items" },
            { name:'edit', type:1, description:"Edit a to-do", options:[
                { name:'number', type:4, description:"To-do item number", required:true },
                { name:'content', type:3, description:"New content", required:true }
            ]}
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
    // --- [NEW FEATURE] Pin a random message from this channel as a quote (fun admin tool) ---
    {
        name: "pinrandom",
        description: "Pick a random message and save as quote (fun admin tool)",
        default_member_permissions: (PermissionFlagsBits.ManageMessages).toString()
    },
    // [NEW]: DAILY REWARD feature
    {
        name: "daily",
        description: "Claim your daily reward and keep your streak going!"
    },
    {
        name: "dailyleaderboard",
        description: "Show Daily Reward top streak leaderboard"
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
    // --- NEW FEATURE: PUBLIC USERLIST SLASH COMMAND REGISTRATION ---
    {
        name: 'userlist',
        description: "Show list of all users seen by bot (public, ordered by last update)"
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
    // [NEW FEATURE ADD] CALC COMMAND REGISTRATION
    {
        name: "calc",
        description: "Calculate simple math expressions. Example: 2+2*(3^2)",
        options: [
            { name: "expression", type: 3, description: "Math expression (e.g. 55*3+2)", required: true }
        ]
    },

    {
        name: "dicewar",
        description: "Start a quick Dice War game: two players each roll a die, higher wins. Use `/dicewar @user`",
        options: [
            { name: "opponent", type: 6, description: "User to challenge", required: true }
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
    // --- NEW FEATURE: DICESTREAK ---
    {
        name: "dicestreak",
        description: "Show top users with the best daily dice rolling streaks."
    },




    // --- ADDITIONAL FEATURE: MESSAGE PINNER SLASH COMMAND REGISTRATION ---
    {
        name: "pin",
        description: "Pin any message in the channel by message ID (fun archive & easy lookup).",
        options: [
            { name: "message_id", type: 3, description: "Message ID to pin", required: true },
            { name: "note", type: 3, description: "Optional description/note to attach", required: false }
        ]
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
    },
    {
            name: "dicewarleaderboard",
            description: "Dice War game leaderboard"
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

// --- ADDITIONAL FEATURE: MESSAGE PINNER TABLE SETUP ---
try {
    await db.run(`CREATE TABLE IF NOT EXISTS pinned_messages (
        id INTEGER PRIMARY KEY,
        messageId TEXT NOT NULL,
        pinnerId TEXT NOT NULL,
        note TEXT,
        pinnedAt INTEGER NOT NULL
    )`);
} catch {}


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
    
    // --- ADDITIONAL FEATURE: /randomuser: Pick a random user who has participated recently ---
    if (interaction.isChatInputCommand && interaction.commandName === 'randomuser') {
        try {
            // We'll consider the last 1000 message_logs as "recent participants"
            let logs = await db.all("SELECT userId FROM message_logs WHERE userId IS NOT NULL ORDER BY createdAt DESC LIMIT 1000");
            let pool = Array.from(new Set(logs.map(l => l.userId))); // Unique list
            if (!pool.length) {
                await interaction.reply({ content: "No recent users found to pick from!", allowedMentions: { parse: [] } });
                return;
            }
            // Pick one at random
            let pickId = pool[Math.floor(Math.random() * pool.length)];
            let uname = pickId;
            try {
                let u = await client.users.fetch(pickId);
                uname = u.username;
            } catch {}
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🎲 Random User Picker")
                        .setDescription(`Randomly picked user: **${uname}**!`)
                        .setFooter({ text: `Random pick from ${pool.length} recent users.` })
                        .setColor(0x6ee7b7)
                ],
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({ content: "Failed to pick a user randomly.", allowedMentions: { parse: [] } });
        }
        return;
    }


    // --- ADDITIONAL FEATURE: /settings_user PER-USER SETTINGS (Mute XP) ---
    if (interaction.isChatInputCommand && interaction.commandName === 'settings_user') {
        let mutedColumnExists = false;
        // Ensure user_settings table exists with mute_xp
        try {
            await db.run(`CREATE TABLE IF NOT EXISTS user_settings (
                userId TEXT PRIMARY KEY,
                mute_xp INTEGER NOT NULL DEFAULT 0,
                updatedAt INTEGER NOT NULL DEFAULT 0
            )`);
            mutedColumnExists = true;
        } catch {}
        // Set or clear mute_xp
        if (interaction.options.getBoolean && interaction.options.getBoolean('mute_xp') === true) {
            await db.run('INSERT OR REPLACE INTO user_settings(userId, mute_xp, updatedAt) VALUES (?,?,?)', interaction.user.id, 1, Date.now());
            await interaction.reply({ content: "🔇 You have muted your XP gain! You will not receive XP for messages until you clear this.", allowedMentions: { parse: [] } });
            return;
        }
        if (interaction.options.getBoolean && interaction.options.getBoolean('clear_xp_mute') === true) {
            await db.run('INSERT OR REPLACE INTO user_settings(userId, mute_xp, updatedAt) VALUES (?,?,0)', interaction.user.id, 0, Date.now());
            await interaction.reply({ content: "✅ Your XP mute has been cleared! You will receive XP for messages again.", allowedMentions: { parse: [] } });
            return;
        }
        // Status display
        let settingsRec = await db.get('SELECT mute_xp FROM user_settings WHERE userId=?', interaction.user.id);
        if (settingsRec && settingsRec.mute_xp) {
            await interaction.reply({ content: "Your XP gain is currently **muted**. Use this command with `clear_xp_mute` to restore.", allowedMentions: { parse: [] } });
        } else {
            await interaction.reply({ content: "Your XP gain is currently **active**.", allowedMentions: { parse: [] } });
        }
        return;
    }


    // --- ADDITIONAL FEATURE: REPORT MESSAGE CONTEXT MENU ---
    if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === "Report") {
        // Pop up a modal for report reason
        const modal = new ModalBuilder()
            .setTitle('Report Message')
            .setCustomId('report_message_modal_' + interaction.targetMessage.id)
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reason')
                        .setLabel('Reason for reporting')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Why is this message being reported?')
                        .setRequired(true)
                )
            );
        client._pendingReportModalMsgId = interaction.targetMessage.id;
        client._pendingReportContextUser = interaction.user;
        await interaction.showModal(modal);
        return;
    }
    // Modal submit handler for report modal
    if (interaction.isModalSubmit?.() && interaction.customId?.startsWith?.('report_message_modal_')) {
        // Confirm modal submit, extract info
        const messageId = interaction.customId.replace('report_message_modal_', '');
        const reason = interaction.fields.getTextInputValue('reason');
        let reportingUser = client._pendingReportContextUser || interaction.user;
        // Call the same logic as /report, but programmatically
        try {
            const chan = await client.channels.fetch(CHANNEL_ID);
            let msg;
            try {
                msg = await chan.messages.fetch(messageId);
            } catch {
                msg = null;
            }
            // Prepare report
            let reports = [];
            try { reports = await readJSONFile("reports.json", []); } catch {}
            const reportObj = {
                reporterId: reportingUser.id,
                reporterName: reportingUser.username,
                messageId: messageId,
                reportedContent: msg ? msg.content : "[Deleted/unavailable]",
                reportedAuthorId: msg ? msg.author.id : null,
                reportedAuthorName: msg ? msg.author.username : null,
                reason,
                reportedAt: Date.now()
            };
            reports.push(reportObj);
            if (reports.length > 50) reports = reports.slice(-50);
            await saveJSONFile("reports.json", reports);
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🚩 Message Reported")
                        .setDescription(`Message ${msg ? `from "${msg.author.username}"` : `[unavailable]`} has been reported.`)
                        .addFields(
                            { name: "Reason", value: reason },
                            { name: "Message ID", value: messageId },
                            { name: "Reporter", value: reportingUser.username }
                        )
                        .setFooter({ text: "All reports are public and logged in /reports" })
                        .setColor(0xff3b3b)
                        .setTimestamp()
                ],
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({ content: "Failed to report the message. Make sure the ID is correct!", allowedMentions: { parse: [] } });
        }
        client._pendingReportModalMsgId = null;
        client._pendingReportContextUser = null;
        return;
    }


    // --- GG COMMAND HANDLERS ---
    if (interaction.isChatInputCommand && (interaction.commandName === "gg" || interaction.commandName === "ggleaderboard")) {
        // Ensure table
        try { await db.run("CREATE TABLE IF NOT EXISTS ggrecords (userId TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)"); } catch {}
        if (interaction.commandName === "gg") {
            let row = await db.get("SELECT count FROM ggrecords WHERE userId=?", interaction.user.id);
            let count = row ? row.count : 0;
            await interaction.reply({
                content: `👏 You have sent "gg" ${count} time${count===1?"":"s"} in this channel! Keep congratulating others!`,
                allowedMentions: { parse: [] }
            });
        } else {
            // Leaderboard
            let recs = await db.all("SELECT * FROM ggrecords ORDER BY count DESC LIMIT 10");
            if (!recs.length) {
                await interaction.reply({ content: "No GGs have been sent yet! Be the first to say gg!", allowedMentions: { parse: [] } });
                return;
            }
            // Fetch usernames
            let nameMap = {};
            for (const r of recs) {
                try {
                    let user = await client.users.fetch(r.userId);
                    nameMap[r.userId] = user.username;
                } catch {
                    nameMap[r.userId] = r.userId;
                }
            }
            let desc = recs.map((r,i)=>`#${i+1}: **${nameMap[r.userId]}** — ${r.count} GG👏`).join('\n');
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("👏 GG Leaderboard")
                        .setDescription(desc)
                        .setColor(0x96fbc7)
                ],
                allowedMentions: { parse: [] }
            });
        }
        return;
    }


    // GG LEADERBOARD context menu: right-click
    if (interaction.isUserContextMenuCommand?.() && interaction.commandName === "GG Leaderboard") {
        try { await db.run("CREATE TABLE IF NOT EXISTS ggrecords (userId TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)"); } catch {}
        let recs = await db.all("SELECT * FROM ggrecords ORDER BY count DESC LIMIT 10");
        if (!recs.length) {
            await interaction.reply({ content: "No GGs have been sent yet! Be first to say 'gg' in chat to appear here!", allowedMentions: { parse: [] }});
            return;
        }
        let nameMap = {};
        for (const r of recs) {
            try {
                let user = await client.users.fetch(r.userId);
                nameMap[r.userId] = user.username;
            } catch {
                nameMap[r.userId] = r.userId;
            }
        }
        let desc = recs.map((r,i)=>`#${i+1}: **${nameMap[r.userId]}** — ${r.count} GG👏`).join('\n');
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("👏 GG Leaderboard")
                    .setDescription(desc)
                    .setColor(0xfffca8)
            ],
            allowedMentions: { parse: [] }
        });
        return;
    }


    // --- NEW FEATURE: /myreactions ---

    if (interaction.isChatInputCommand && interaction.commandName === "myreactions") {
        // Show messages the user has reacted to (+ what type), most recent 10, as a public "reaction history"
        let rows = await db.all(`
            SELECT messageId, reaction, ts FROM reactions
            WHERE userId=?
            ORDER BY ts DESC
            LIMIT 10
        `, interaction.user.id);
        if (!rows || !rows.length) {
            await interaction.reply({content: "You haven't reacted to any messages yet!", allowedMentions: { parse: [] }});
            return;
        }
        let lines = [];
        const chan = await client.channels.fetch(CHANNEL_ID);
        for (const row of rows) {
            let msgContent = "";
            let jumplink = "";
            try {
                let msg = await chan.messages.fetch(row.messageId);
                msgContent = msg.content ? msg.content.slice(0,60) : "[no content]";
                jumplink = msg.url ? `[jump](${msg.url})` : "";
            } catch {
                msgContent = "[deleted/unavailable]";
            }
            lines.push(`${row.reaction} on "${msgContent}" ${jumplink} (<t:${Math.floor(row.ts/1000)}:R>)`);
        }
        let embed = new EmbedBuilder()
            .setTitle("🛠️ Your Most Recent Reactions")
            .setDescription(lines.join("\n"))
            .setColor(0xdfa2d0);
        await interaction.reply({embeds: [embed], allowedMentions: { parse: [] }});
        return;
    }
    // --- [FEATURE] FEEDBACK BOARD ---
    if (interaction.isChatInputCommand && interaction.commandName === "feedback") {
        // Post public feedback (anyone can submit, upvote/downvote)
        let fbText = interaction.options.getString("text")?.trim();
        if (!fbText || fbText.length < 4) {
            await interaction.reply({content: "Feedback too short. Please give a longer comment!", allowedMentions: { parse: [] }});
            return;
        }

        if (fbText.length > 500) fbText = fbText.slice(0,500);
        let uname;
        try {
            let u = await client.users.fetch(interaction.user.id);
            uname = u.username;
        } catch { uname = interaction.user.id; }
        await db.run("INSERT INTO feedback(userId, username, text, createdAt, voters) VALUES (?,?,?,?,?)",
            interaction.user.id, uname || interaction.user.id, fbText, Date.now(), JSON.stringify([]));

        const lastId = (await db.get("SELECT id FROM feedback ORDER BY id DESC LIMIT 1"))?.id;
        const embed = new EmbedBuilder()
            .setTitle("🗣️ New Public Feedback")
            .setDescription(`"${fbText}"\n\nBy: ${uname}`)
            .setFooter({ text: `Community voting welcome!` })
            .setColor(0x3498db)
            .setTimestamp();
        // Buttons for upvote/downvote
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`fb_up_${lastId}`).setLabel("👍 Upvote").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`fb_down_${lastId}`).setLabel("👎 Downvote").setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({
            embeds: [embed],
            components: [row],
            allowedMentions: { parse: [] }
        });
        // --- ADDITIONAL FEATURE: REPORT MESSAGES COMMAND (slash) ---
        // Register "report" command if not yet registered.
        try {
            const commandsList = await rest.get(
                Routes.applicationGuildCommands((await client.application?.id) || "0", GUILD_ID)
            );
            if (!commandsList.find(cmd => cmd.name === "report")) {
                await rest.post(
                    Routes.applicationGuildCommands((await client.application?.id) || "0", GUILD_ID),
                    { body: [{
                        name: "report",
                        description: "Report a message for review.",
                        options: [
                            { name: "message_id", type: 3, description: "Message ID to report", required: true },
                            { name: "reason", type: 3, description: "Reason for reporting", required: true }
                        ]
                    }] }
                );
            }
        } catch (e) { }
        return;

    }

    if (interaction.isChatInputCommand && interaction.commandName === "joke") {
        // Provide fun programming/general joke using static list
        const jokes = [
            "Why do programmers prefer dark mode? Because light attracts bugs!",
            "How many programmers does it take to change a light bulb? None. It's a hardware problem!",
            "Why do Java developers wear glasses? Because they can't C#.",
            "To understand what recursion is, you must first understand recursion.",
            "A SQL query walks into a bar, walks up to two tables and asks: 'Can I join you?'",
            "Why did the function return early? Because it had a date with an exception.",
            "Real programmers count from 0.",
            "There are 10 types of people: those who understand binary, and those who don’t.",
            "Why couldn’t the leopard play hide and seek? Because he was always spotted.",
            "What do you call 8 hobbits? A hobbyte.",
            "Why did the scarecrow win an award? Because he was outstanding in his field.",
            "Why couldn't the bicycle stand up by itself? It was two-tired."
        ];
        const joke = jokes[Math.floor(Math.random() * jokes.length)];
        const embed = new EmbedBuilder()
            .setTitle("😂 Random Joke")
            .setDescription(joke)
            .setColor(0xfff200)
            .setFooter({ text: "Submit more fun jokes with /feedback!" });
        await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        return;
    }

    if (interaction.isChatInputCommand && interaction.commandName === "feedbacklist") {
        // Show most recent 6 feedback entries, highest voted first
        let recs = await db.all(
            `SELECT * FROM feedback ORDER BY upvotes - downvotes DESC, upvotes DESC, createdAt DESC LIMIT 6`
        );
        if (!recs.length) {
            await interaction.reply({content: "No feedback posted yet! Use `/feedback` to add your own.", allowedMentions: { parse: [] }});
            return;
        }
        let embeds = recs.map((r) => {
            return new EmbedBuilder()
                .setTitle(`Feedback #${r.id}`)
                .setDescription(`"${r.text}"`)
                .addFields({ name: "By", value: r.username, inline: true },
                           { name: "👍 Upvotes", value: `${r.upvotes}`, inline: true },
                           { name: "👎 Downvotes", value: `${r.downvotes}`, inline: true })
                .setFooter({ text: `ID: ${r.id} | Use /feedback to post your own!` })
                .setColor(0xeeeeee)
                .setTimestamp(r.createdAt);
        });
        await interaction.reply({embeds: embeds, allowedMentions: { parse: [] }});
        return;
    }


    // --- FEEDBACK BOARD BUTTONS ---
    if (interaction.isButton() && (/^fb_(up|down)_\d+$/.test(interaction.customId))) {
        const [_, type, id] = interaction.customId.split("_");
        const fid = Number(id);
        let row = await db.get("SELECT * FROM feedback WHERE id=?", fid);
        if (!row)
            return void interaction.reply({ content: "That feedback entry doesn't exist!", allowedMentions: { parse: [] } });

        let voters = [];
        try { voters = JSON.parse(row.voters || "[]"); } catch { voters = []; }
        if (voters.includes(interaction.user.id)) {
            await interaction.reply({ content: "You already voted on this feedback.", allowedMentions: { parse: [] } });
            return;
        }
        voters.push(interaction.user.id);

        let newUp = row.upvotes, newDn = row.downvotes;
        if (type === "up") newUp++;
        else if (type === "down") newDn++;

        await db.run(`UPDATE feedback SET upvotes=?, downvotes=?, voters=? WHERE id=?`,
            newUp, newDn, JSON.stringify(voters), fid);

        let embed = new EmbedBuilder()
            .setTitle(`🗣️ Feedback #${fid}`)
            .setDescription(row.text)
            .addFields({ name: "By", value: row.username, inline: true },
                       { name: "👍 Upvotes", value: `${newUp}`, inline: true },
                       { name: "👎 Downvotes", value: `${newDn}`, inline: true })
            .setTimestamp(row.createdAt)
            .setFooter({ text: `Thank you for voting!` })
            .setColor(0x13c5bb);

        await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        return;
    }
    
    // --- SLASH: UPVOTES ---
    if (interaction.isChatInputCommand && interaction.commandName === "upvotes") {
        // Top upvoted messages as public leaderboard
        let votes = [];
        try {
            votes = await db.all(`
                SELECT messageId, COUNT(*) as votes
                FROM reactions
                WHERE reaction='👍'
                GROUP BY messageId
                ORDER BY votes DESC
                LIMIT 5
            `, []);
        } catch {}
        if (!votes || !votes.length) {
            await interaction.reply({content: `No upvoted messages yet!`});
            return;
        }
        let embed = new EmbedBuilder()
            .setTitle("🌟 Top Upvoted Messages")
            .setDescription("The most 'Thumbs Up' messages in this channel.");
        let lines = [];
        for (let row of votes) {
            try {
                let chan = await client.channels.fetch(CHANNEL_ID);
                let msg = await chan.messages.fetch(row.messageId);
                let jumplink = msg.url ? `[jump](${msg.url})` : "";
                lines.push(`> "${msg.content.slice(0,60)}" — **${row.votes} 👍** ${jumplink}`);
            } catch {
                lines.push(`(Message deleted) — **${row.votes} 👍**`);
            }
        }
        embed.setDescription(lines.join("\n") || `No upvoted messages found.`);
        await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});
        return;
    }
    // --- SLASH: DOWNVOTES ---
    if (interaction.isChatInputCommand && interaction.commandName === "downvotes") {
        // Top downvoted messages
        let votes = [];
        try {
            votes = await db.all(`
                SELECT messageId, COUNT(*) as votes
                FROM reactions
                WHERE reaction='👎'
                GROUP BY messageId
                ORDER BY votes DESC
                LIMIT 5
            `, []);
        } catch {}
        if (!votes || !votes.length) {
            await interaction.reply({content: `No downvoted messages yet!`, allowedMentions: { parse: [] }});
            return;
        }
        let embed = new EmbedBuilder()
            .setTitle("💢 Most Downvoted Messages")
            .setDescription("The most 'Thumbs Down' messages in this channel.");
        let lines = [];
        for (let row of votes) {
            try {
                let chan = await client.channels.fetch(CHANNEL_ID);
                let msg = await chan.messages.fetch(row.messageId);
                let jumplink = msg.url ? `[jump](${msg.url})` : "";
                lines.push(`> "${msg.content.slice(0,60)}" — **${row.votes} 👎** ${jumplink}`);
            } catch {
                lines.push(`(Message deleted) — **${row.votes} 👎**`);
            }
        }
        embed.setDescription(lines.join("\n") || `No downvoted messages found.`);
        await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});
        return;
    }
    
    
    // XP LEADERBOARD BUTTON

    if (interaction.isButton() && interaction.customId === "xp_leaderboard") {
        // Respond with leaderboard of top 10 in embed, using username, no mention
        try {
            const rows = await db.all('SELECT userId, xp, level FROM xp ORDER BY level DESC, xp DESC LIMIT 10');
            // Get user tags from user_tags table for display
            let userTags = {};
            try {
                for (let row of rows) {
                    let tagRec = await db.get('SELECT tag FROM user_tags WHERE userId=?', row.userId);
                    userTags[row.userId] = tagRec && tagRec.tag ? tagRec.tag : row.userId;
                }
            } catch {}
            if (!rows.length) return void interaction.reply({content:"Leaderboard empty.",ephemeral:true, allowedMentions: { parse: [] }});

            let msg = rows.map((r,i)=>`**#${i+1}: ${userTags[r.userId] || r.userId} — Level ${r.level} (${r.xp} XP)**`).join('\n');
            await interaction.reply({
                embeds:[new EmbedBuilder().setTitle("🏅 XP Leaderboard").setDescription(msg).setColor(0xF9D923)],
                allowedMentions: { parse: [] }
            });
        } catch {
            await interaction.reply({content:"Failed to show XP leaderboard.", allowedMentions: { parse: [] }});
        }
        return;
    }

    

    // --- NEW FEATURE: /pinrandom: Pin a random message as quote (admin/fun tool) ---
    if (interaction.isChatInputCommand && interaction.commandName === "pinrandom") {
        // Permissions not required per instructions (works for all for demo), but leave admin role wording in embed.
        try {
            // Fetch up to 100 recent (non-bot) messages. Adjust as needed for performance.
            let chan = await client.channels.fetch(CHANNEL_ID);
            let msgsRaw = await chan.messages.fetch({ limit: 100 });
            // Filter out bot/self messages and system messages
            let msgs = [...msgsRaw.values()].filter(m => !m.author.bot && !m.system && m.content && m.content.trim().length > 2);
            if (!msgs.length) {
                await interaction.reply({ content: "No suitable messages found to pin as a quote." });
                return;
            }
            // Pick at random
            let pick = msgs[Math.floor(Math.random() * msgs.length)];
            // Save as quote
            let quotes = await readJSONFile("quotes.json", []);
            quotes.push({
                user: {id: pick.author.id, tag: pick.author.tag },
                content: pick.content,
                timestamp: pick.createdTimestamp,
                category: "pinned-random"
            });
            await saveJSONFile("quotes.json", quotes);
            // Visual feedback
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("📌 Random Message Pinned as Quote!")
                        .setDescription(`"${pick.content}"\n\n— <@${pick.author.id}> (${pick.author.tag})`)
                        .setFooter({ text: `Picked at random by <@${interaction.user.id}> (Admin tool)` })
                        .setColor(0xf08080)
                ]
            });
        } catch(e) {
            await interaction.reply({ content: "Failed to pin a random quote.", allowedMentions: { parse: [] } });

        }
        return;
    }
    

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
        try { await interaction.reply({content: 'Internal error: Could not fetch channel context.', allowedMentions: { parse: [] }}); } catch{}
        return;
    }


    // Defend: prevent errors if interaction.options is not present (Discord lib bug or corruption!)
    if (typeof interaction.isChatInputCommand === "function" && interaction.isChatInputCommand() && !interaction.options) {
        try { await interaction.reply({content:'Internal error: Missing options.', allowedMentions: { parse: [] }}); } catch {}
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
                    .setTitle(`${tgt.username}'s Avatar`)
                    .setImage(tgt.displayAvatarURL({ extension: 'png', size: 4096}))
                    .setColor(0x30cdfa)
            ],
            allowedMentions: { parse: [] }
        });
        return;
    }

    // --- PUBLIC FEATURE: USERLIST ---
    if (interaction.isChatInputCommand() && interaction.commandName === "userlist") {
        // Fetch all users from user_tags table (ordered by updatedAt desc)
        let users = [];
        try {
            users = await db.all("SELECT userId, tag, updatedAt FROM user_tags ORDER BY updatedAt DESC");
        } catch {}
        if (!users.length) {
            await interaction.reply({ content: "No user data recorded yet.", allowedMentions: { parse: [] } });
            return;
        }
        // Try to grab join date from message_logs (oldest message timestamp per user)
        let msgLogMap = {};
        try {
            const logs = await db.all("SELECT userId, MIN(createdAt) as minTs FROM message_logs GROUP BY userId");
            for (const row of logs) {
                msgLogMap[row.userId] = row.minTs;
            }
        } catch {}

        // Compose description, username (or stored user tag), join date if known.
        let desc = users.map((u,i) => {
            let join = msgLogMap[u.userId] ? `<t:${Math.floor(msgLogMap[u.userId]/1000)}:d>` : "N/A";
            return `**[${i+1}]** ${u.tag} (joined: ${join})`;
        }).join("\n");

        // Discord embed description max 4096, but reserve room just in case.
        if (desc.length > 3900) {
            desc = desc.slice(0, 3900) + `\n...and more! (Showing first ${users.length} users)`;
        }
        let embed = new EmbedBuilder()
            .setTitle("👥 All Users Seen")
            .setDescription(desc)
            .setFooter({ text: "User info updated on message/chat." })
            .setColor(0xa7f3d0);
        await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
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

    // --- SLASH: FUNFACT ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'funfact') {
        // Fun facts list (expand as desired)
        const funFacts = [
            "Honey never spoils. Archaeologists have eaten 3,000-year-old honey and found it edible!",
            "A group of flamingos is called a 'flamboyance.'",
            "Bananas are technically berries, but strawberries aren't.",
            "The Eiffel Tower can be 15 cm taller during hot days.",
            "Octopuses have three hearts.",
            "You can't hum while holding your nose (try it!).",
            "There are more trees on Earth than stars in the Milky Way.",
            "Wombat poops are cube-shaped.",
            "Oxford University is older than the Aztec Empire.",
            "Some turtles can breathe through their butts.",
            "The unicorn is the national animal of Scotland.",
            "Venus is the only planet that spins clockwise.",
            "A day on Venus is longer than a year on Venus.",
            "The inventor of the Frisbee was turned into a Frisbee after he died.",
            "Cows have best friends and can become stressed when separated.",
            "A single strand of spaghetti is called a 'spaghetto.'",
            "If you shuffle a deck of cards properly, chances are that exact order has never been seen before in history.",
            "Sharks existed before trees.",
            "The wood frog can hold its pee for up to eight months.",
            "Sloths can hold their breath longer than dolphins can."
        ];
        // Save recent fun facts for leaderboard & UX
        let funHist = [];
        try { funHist = await readJSONFile("fun_facts_history.json", []); } catch {}
        const pick = funFacts[Math.floor(Math.random() * funFacts.length)];
        let uname = interaction.user?.username || interaction.user?.id || "Unknown";
        funHist.push({
            user: uname,
            fact: pick,
            at: Date.now()
        });
        // Only keep last 20
        if (funHist.length > 20) funHist = funHist.slice(-20);
        await saveJSONFile("fun_facts_history.json", funHist);
        // --- New Feature Begin ---
        // After posting the fun fact, prompt the user to rate it using buttons
        const rateRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('funfact_rate_5')
                .setLabel('😍 5')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('funfact_rate_4')
                .setLabel('😃 4')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('funfact_rate_3')
                .setLabel('🙂 3')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('funfact_rate_2')
                .setLabel('😐 2')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('funfact_rate_1')
                .setLabel('🥱 1')
                .setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                  .setTitle("🎉 Fun Fact")
                  .setDescription(`"${pick}"`)
                  .setFooter({ text: `Shared by ${uname}` })
                  .setColor(0xfcba03)
            ],
            components: [rateRow],
            allowedMentions: { parse: [] }
        });
        // Write to fun facts ratings structure for retrieval and leaderboard
        try {
            let ffRatings = await readJSONFile("funfacts_ratings.json", []);
            // Save as: {fact, by, at, ratings: [{userId, value}], id}
            let id = (funHist.length > 0 ? `${funHist.length}_${Date.now()}` : Date.now().toString());
            ffRatings.push({
                id,
                fact: pick,
                author: uname,
                at: Date.now(),
                ratings: []
            });
            if (ffRatings.length > 50) ffRatings = ffRatings.slice(-50);
            await saveJSONFile("funfacts_ratings.json", ffRatings);
        } catch {}
        return;
    }


    // --- SLASH: MEME ---
    if (interaction.isChatInputCommand() && interaction.commandName === "meme") {
        // Fetch a meme from an API, fallback to static list if API fails
        let memeData = null;
        let title = "";
        let imageUrl = "";
        let source = "";
        let fallbackMemes = [
            {
                title: "Programmer Owl",
                url: "https://i.kym-cdn.com/entries/icons/original/000/030/964/cover2.jpg",
                source: "KYM"
            },
            {
                title: "Math Lady",
                url: "https://i.imgur.com/4M7IWwP.jpg",
                source: "imgur"
            },
            {
                title: "Distracted Boyfriend",
                url: "https://i.imgur.com/SHlV9iO.jpg",
                source: "imgur"
            }
        ];
        try {
            // Try to fetch from Reddit's meme API or similar free endpoint
            const resp = await fetch("https://meme-api.com/gimme");
            memeData = await resp.json();
            title = memeData.title;
            imageUrl = memeData.url;
            source = memeData.postLink;
        } catch (e) {
            // Use fallback
            let pick = fallbackMemes[Math.floor(Math.random()*fallbackMemes.length)];
            title = pick.title;
            imageUrl = pick.url;
            source = pick.source;
        }
        const embed = new EmbedBuilder()
            .setTitle(`🖼️ Meme${title ? ": " + title : ""}`)
            .setDescription(source ? `Source: ${source}` : "")
            .setImage(imageUrl)
            .setColor(0xf5b041);
        await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        return;
    }


    // --- SLASH: FUNFACTS (recent posts leaderboard) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'funfacts') {
        // Show rating leaderboard, then recent facts
        let ffRatings = [];
        try { ffRatings = await readJSONFile("funfacts_ratings.json", []); } catch {}
        let leaderboardText = "";
        if (ffRatings.length > 0) {
            // Compute leaderboard by author (average rating, min 3 ratings)
            let stats = {};
            for (const ff of ffRatings) {
                if (!stats[ff.author]) stats[ff.author] = { total:0, count:0, facts:0 };
                let avg = ff.ratings?.length
                    ? ff.ratings.reduce((s, r) => s + r.value, 0) / ff.ratings.length
                    : 0;
                if (ff.ratings?.length >= 3) {
                    stats[ff.author].total += avg;
                    stats[ff.author].count++;
                }
                stats[ff.author].facts++;
            }
            let authors = Object.keys(stats)
                .filter(name => stats[name].count > 0)
                .map(name => ({
                    name,
                    facts: stats[name].facts,
                    avg: (stats[name].total / stats[name].count).toFixed(2),
                    count: stats[name].count
                }))
                .sort((a, b) => b.avg - a.avg)
                .slice(0, 3);
            if (authors.length) {
                leaderboardText += `🌟 **Fun Fact Rating Leaders**:`;
                for (const [idx, a] of authors.entries()) {
                    leaderboardText += `\n${idx+1}. ${a.name} (Avg Rating: ${a.avg}, from ${a.count} rated facts, total facts: ${a.facts})`;
                }
                leaderboardText += "\n";
            }
        }
        // Show last 6 facts from /data/fun_facts_history.json
        let funHist = [];
        try { funHist = await readJSONFile("fun_facts_history.json", []); } catch {}
        if (!funHist.length) {
            await interaction.reply({content:"No fun facts shared yet. Try `/funfact` to share one!", allowedMentions: { parse: [] }});
            return;
        }
        const factsToShow = funHist.slice(-6).reverse();
        let embed = new EmbedBuilder()
            .setTitle("🎉 Recent Fun Facts")
            .setDescription([
                leaderboardText,
                factsToShow.map((f, i) =>
                    `**[${i+1}]** ${f.fact}\n*— ${f.user} (<t:${Math.floor(f.at/1000)}:R>)*`
                ).join("\n\n")
            ].join("\n"))
            .setFooter({text: "Want to share more? Use /funfact! Rate facts 1–5 with the buttons!"})
            .setColor(0xfde68a);
        await interaction.reply({
            embeds: [embed],
            allowedMentions: { parse: [] }
        });
        return;
    }




    // --- SLASH: QUOTES (random, filter by tag) ---
    if (interaction.isChatInputCommand() && interaction.commandName === "quotes") {
        const quotes = await readJSONFile("quotes.json", []);
        if (!quotes.length) return void interaction.reply({content:"No quotes saved.", allowedMentions: { parse: [] }});

        // If user types something like "/quotes category=tag" use it
        let txt = interaction.options? interaction.options.getString?.('category') : undefined;
        let show = quotes;
        // Support filtering by slash command option now!
        if (!interaction.options) txt = undefined;
        else txt = interaction.options.getString?.('category');
        if (txt) show = quotes.filter(q=>q.category && q.category.toLowerCase().includes(txt.toLowerCase()));
        const q = show[Math.floor(Math.random()*show.length)];
        if (!q) return void interaction.reply({content:"No quotes matching that tag!", allowedMentions: { parse: [] }});

        const embed = new EmbedBuilder()
            .setTitle("💬 Saved Quote")
            .setDescription(`"${q.content}"`)
            .setFooter({text: `By ${(q.user?.tag || q.author_tag || "Unknown")} at <t:${Math.floor(q.timestamp/1000)}:f>${q.category?` | #${q.category}`:""}`});
        await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});
        return;
    }

    // --- SLASH: QUOTELEADERBOARD ---
    if (interaction.isChatInputCommand() && interaction.commandName === "quoteleaderboard") {
        // Show top quoted users (author_tag or q.user.tag) in /quotes.json
        const quotes = await readJSONFile("quotes.json", []);
        if (!quotes.length) return void interaction.reply({ content: "No quotes saved yet.", allowedMentions: { parse: [] } });
        // Tally: tag or author_tag
        let counts = {};
        for (const q of quotes) {
            let tag = q.user?.tag || q.author_tag || "Unknown";
            counts[tag] = (counts[tag] || 0) + 1;
        }
        let sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 10);
        let desc = sorted.map(([tag, n], i) => `#${i+1}: **${tag}** — ${n} quote${n===1?"":"s"}`).join("\n");
        let embed = new EmbedBuilder()
            .setTitle("🏆 Quote Leaderboard")
            .setDescription(desc)
            .setColor(0xffc300);
        await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        return;
    }

    // ---------- NEW FEATURE: PUBLIC QUOTE SEARCH BY AUTHOR ----------
    // /quotesearch author: <tag-or-partial>
    if (interaction.isChatInputCommand && interaction.commandName === "quotesearch") {
        // Only allow in main channel for public display
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content: "Use this command in the main channel only.", allowedMentions: { parse: [] }});
            return;
        }
        const author = interaction.options.getString("author");
        if (!author || author.length < 2) {
            await interaction.reply({content: "Please provide at least 2 characters of the author to search.", allowedMentions: { parse: [] }});
            return;
        }
        const quotes = await readJSONFile("quotes.json", []);
        // Search by partial author tag (case-insensitive)
        const results = quotes.filter(q => (q.user?.tag || q.author_tag || "").toLowerCase().includes(author.toLowerCase()));
        if (!results.length) {
            await interaction.reply({content: `No quotes found for author containing "${author}".`, allowedMentions: { parse: [] }});
            return;
        }
        // Show at most 10 results
        const view = results.slice(-10).reverse();
        const embed = new EmbedBuilder()
            .setTitle(`💬 Quotes by "${author}"`)
            .setDescription(view.map((q, i) =>
                `**[${i+1}]** "${q.content}"\n— ${q.user?.tag || q.author_tag || "Unknown"} (${q.category ? "#" + q.category : ""}) _<t:${Math.floor((q.timestamp||Date.now())/1000)}:f>_`
            ).join("\n\n"))
            .setColor(0xabc4ff)
            .setFooter({ text: `Showing last ${view.length} quotes by author match` });
        await interaction.reply({embeds: [embed], allowedMentions: { parse: [] }});
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
            ], allowedMentions: { parse: [] }
        });
        return;
    }





    // --- SLASH: NOTE ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'note') {
        // Restrict all note commands to PUBLIC main channel (fix restriction: DM not allowed)
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"Notes are public, use in the main channel.",ephemeral:false, allowedMentions: { parse: [] }}); return;
        }
        if (interaction.options.getSubcommand() === 'add') {

            const txt = interaction.options.getString('content').substring(0, 500);
            await db.run('INSERT INTO notes(userId, note, timestamp) VALUES (?,?,?)',
                interaction.user.id, txt, Date.now());
            await interaction.reply({content:'📝 Note saved! (All notes are public in-channel; use `/todo` for personal items)', allowedMentions: { parse: [] }});

        } else if (interaction.options.getSubcommand() === 'list') {
            const rows = await db.all('SELECT id, note, timestamp, userId FROM notes ORDER BY id DESC LIMIT 10');
            if (rows.length === 0) { await interaction.reply({content:"No notes yet.", allowedMentions: { parse: [] }}); }
            else {
                const embed = new EmbedBuilder()
                  .setTitle("Last 10 Public Notes")
                  .setDescription(rows.map((r,i) => `**[${rows.length-i}]** ${client.users.cache.get(r.userId)?.username || r.userId}: ${r.note} _(at <t:${Math.floor(r.timestamp/1000)}:f>)_`).join("\n"))
                  .setColor(0x80ecec);
                await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});
            }

        } else if (interaction.options.getSubcommand() === 'delete') {

            const idx = interaction.options.getInteger('number');
            const allRows = await db.all('SELECT id, userId FROM notes ORDER BY id DESC LIMIT 10');
            if (!allRows[idx-1]) return void interaction.reply({content:"Invalid note number!", allowedMentions: { parse: [] }});

            // Allow any user to delete any note for public UX (demonstration mode)
            await db.run('DELETE FROM notes WHERE id=?', allRows[idx-1].id);
            await interaction.reply({content:"🗑️ Note deleted.", allowedMentions: { parse: [] }});

        } else if (interaction.options.getSubcommand() === "pin") {
            await interaction.reply({content:"⚠️ To pin notes, please use `/todo add` with the note content! (To-Do is now public)", allowedMentions: { parse: [] }});

        } else if (interaction.options.getSubcommand() === "pinned") {
            const todos = await db.all("SELECT content, done, ts, userId FROM todo_entries ORDER BY ts DESC");
            if (!todos.length)
                return void interaction.reply({content:"No pinned notes (all pinned notes are now in `/todo list` as the To-Do list, public to all).", allowedMentions: { parse: [] }});
            const embed = new EmbedBuilder()
                .setTitle("📝 Pinned Notes (Public To-Do List)")
                .setDescription(todos.slice(0,10).map((t,i)=>`${t.done?'✅':'❌'} **[${i+1}]** ${client.users.cache.get(t.userId)?.username || t.userId}: ${t.content} _(at <t:${Math.floor(t.ts/1000)}:f>)_`).join("\n"))
                .setColor(0xfecf6a);
            await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});

        } else if (interaction.options.getSubcommand() === "search") {

            const query = interaction.options.getString("query").toLowerCase();
            const rows = await db.all('SELECT note, timestamp, userId FROM notes ORDER BY id DESC LIMIT 50');
            const matches = rows.filter(r => r.note.toLowerCase().includes(query));
            if (!matches.length) return void interaction.reply({content:`No matching notes found for "${query}".`, allowedMentions: { parse: [] }});

            const embed = new EmbedBuilder()
                .setTitle(`🔎 Notes matching "${query}"`)
                .setDescription(matches.slice(0,10).map((n,i)=>`**[${i+1}]** <@${n.userId}>: ${n.note} _(at <t:${Math.floor(n.timestamp/1000)}:f>)_`).join("\n"))
                .setColor(0x4a90e2);
            await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});

        }
        return;
    }





    // --- SLASH: TODO ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'todo') {
        // Only allow in main channel, everywhere public (privacy restriction removed)
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"To-dos are now public, use in the main channel!", ephemeral:false, allowedMentions: { parse: [] }}); return;
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
            await interaction.reply({content:addMsg, allowedMentions: { parse: [] }});

        } else if (sub === "complete") {
            let idx = interaction.options.getInteger('number');
            let rows = await db.all("SELECT id, content FROM todo_entries ORDER BY ts DESC LIMIT 15");
            if (!rows[idx-1]) return void interaction.reply({content:"Invalid to-do #", allowedMentions: { parse: [] }});

            await db.run("UPDATE todo_entries SET done=1 WHERE id=?", rows[idx-1].id);
            await interaction.reply({content:`✅ Marked "${rows[idx-1].content}" as done.`, allowedMentions: { parse: [] }});

        } else if (sub === "remove") {
            let idx = interaction.options.getInteger('number');
            let rows = await db.all("SELECT id FROM todo_entries ORDER BY ts DESC LIMIT 15");
            if (!rows[idx-1]) return void interaction.reply({content:"Invalid to-do #", allowedMentions: { parse: [] }});

            await db.run("DELETE FROM todo_entries WHERE id=?", rows[idx-1].id);
            await interaction.reply({content:"🗑️ To-do removed.", allowedMentions: { parse: [] }});

        } else if (sub === "list") {
            let todos = await db.all("SELECT content, done, ts, userId FROM todo_entries ORDER BY ts DESC");
            if (!todos.length) return void interaction.reply({content:"To-do list is empty!", allowedMentions: { parse: [] }});

            let embed = new EmbedBuilder()
                .setTitle("📝 Public To-Do List")
                .setDescription(todos.map((t,i)=>`${t.done?'✅':'❌'} **[${i+1}]** <@${t.userId}>: ${t.content} _(at <t:${Math.floor(t.ts/1000)}:f>)_`).join("\n"))
                .setColor(0xfcc063);

            // New UX: count completed and incomplete
            let doneCount = todos.filter(t=>t.done).length;
            embed.setFooter({text:`${todos.length} total, ${doneCount} completed, ${todos.length-doneCount} remaining`});
            await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});

        } else if (sub === "edit") {
            let idx = interaction.options.getInteger('number');
            let newContent = interaction.options.getString('content').substring(0, 300);
            let rows = await db.all("SELECT id, content, userId FROM todo_entries ORDER BY ts DESC LIMIT 15");
            if (!rows[idx-1]) return void interaction.reply({content:"Invalid to-do #", allowedMentions: { parse: [] }});

            let todoId = rows[idx-1].id;
            let oldContent = rows[idx-1].content;
            await db.run("UPDATE todo_entries SET content=?, ts=? WHERE id=?", newContent, Date.now(), todoId);
            await interaction.reply({content: `✏️ To-Do item #${idx} updated.\nBefore: "${oldContent}"\nAfter: "${newContent}"`, allowedMentions: { parse: [] }});

        }
        // NEW FEATURE: Add "Clear All Completed" for fast cleaning up finished items (public, admin/UX tool)
        // Check for "clearall" subcommand via manual trigger (to avoid modifying original to-do slash structure)
        else if (sub === "clearall") {
            // Remove all completed todos
            let completed = await db.all("SELECT id FROM todo_entries WHERE done=1");
            if (completed.length === 0) {
                await interaction.reply({content:"No completed to-dos to clear!", allowedMentions: { parse: [] } });
                return;
            }
            await db.run("DELETE FROM todo_entries WHERE done=1");
            await interaction.reply({content:`🧹 Cleared ${completed.length} completed to-dos from the public to-do list.`, allowedMentions: { parse: [] }});
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
            // Move out DM features to guild channel per restrictions:
            await interaction.channel.send({content:`Admin message to ${user.username}:\n${txt}`, allowedMentions: { parse: [] }});
            await interaction.reply({content:`Sent message to ${user.tag} (as public message due to DM restriction)`, allowedMentions: { parse: [] }});
        } catch {
            await interaction.reply({content:"Failed to send message publicly!", allowedMentions: { parse: [] }});
        }

        return;
    }








    // --- SLASH: TIMER ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'timer') {
        // Only allow in the single main channel (no DM)
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"Use /timer in the main channel only!", ephemeral:true, allowedMentions: { parse: [] }}); return;
        }
        const name = interaction.options.getString('name').substring(0,40);
        const dur = parseTime(interaction.options.getString('duration'));
        if (!dur || isNaN(dur) || dur < 5000) return void interaction.reply({content:"Invalid duration. Min: 5 seconds.", ephemeral:true, allowedMentions: { parse: [] }});

        if (dur > 5*60*60*1000) return void interaction.reply({content:"Timer max is 5 hours.", ephemeral:true, allowedMentions: { parse: [] }});

        await db.run('INSERT INTO timers(userId, name, setAt, duration, running) VALUES (?,?,?,?,1)', interaction.user.id, name, Date.now(), dur);
        setTimeout(async()=>{
          const last = await db.get('SELECT * FROM timers WHERE userId=? AND name=? AND running=1', interaction.user.id, name);
          if (!last) return;
          await db.run('UPDATE timers SET running=0 WHERE id=?', last.id);
          try {
            const chan = client.channels.cache.get(CHANNEL_ID);
            if (chan && chan.isTextBased && chan.send) {
                await chan.send({content: `${client.users.cache.get(interaction.user.id)?.username || interaction.user.id}, ⏰ [TIMER "${last.name}" DONE] Your ${humanizeMs(last.duration)} timer finished!`, allowedMentions: { parse: [] }});
            }
          } catch{}
        }, dur);
        await interaction.reply({content:`⏳ Timer **"${name}"** started for ${humanizeMs(dur)}! I will alert **in this channel** when done.`, allowedMentions: { parse: [] }});

        return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "timers") {
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content:"Use in main channel only",ephemeral:true}); return;
        }
        const rows = await db.all('SELECT name, setAt, duration, running FROM timers WHERE userId=? ORDER BY setAt DESC LIMIT 10', interaction.user.id);
        if (!rows.length) return void interaction.reply({content:"No running or completed timers found.", allowedMentions: { parse: [] }});

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
        if (!delay) return void interaction.reply({content:"Invalid time. Use e.g. 10m, 2h, 1d (or combine, e.g. 1h30m)", ephemeral:true, allowedMentions: { parse: [] }});
        if (delay > 7*24*60*60*1000) return void interaction.reply({content:"Max is 7d.",ephemeral:true, allowedMentions: { parse: [] }});

        await db.run('INSERT INTO reminders(userId, content, remindAt) VALUES (?,?,?)',
            interaction.user.id, content, Date.now() + delay);

        // Additional Feature: Confirm with persistent reminder view button (UX improvement)
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('reminders_view_btn')
                .setLabel('View All Reminders')
                .setStyle(ButtonStyle.Primary)
        );
        await interaction.reply({
            content:`⏰ Reminder set! I'll remind **in the main channel** in ${humanizeMs(delay)}.`,
            components: [row],
            allowedMentions: { parse: [] }
        });

        scheduleReminders(client);

        // --------- [NEW FEATURE] QUICK SET "RECURRING REMINDER" PUBLIC BUTTON ----------
        // Button row, only if not already present
        const recurRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('recurreminder_'+content.replace(/\W/g,"").slice(0,20))
                .setLabel('Set This As Daily Recurring Reminder')
                .setStyle(ButtonStyle.Secondary)
        );
        // Only show for simple <2d reminders, for demo
        if (delay <= 2*24*60*60*1000) {
            await interaction.followUp({
                content: `Want this to repeat every day? Click below to convert into a daily recurring reminder!`,
                components: [recurRow],
                allowedMentions: { parse: [] }
            });
        }
        return;
    }


    // --- ADDITIONAL FEATURE: REMINDER REMOVE COMMAND ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'reminderremove') {
        // List this user's pending reminders and allow remove by number
        let num = interaction.options.getInteger('number');
        let rows = await db.all('SELECT id, content, remindAt FROM reminders WHERE userId=? ORDER BY remindAt ASC', interaction.user.id);
        if (!rows || !rows.length || num < 1 || num > rows.length) {
            await interaction.reply({ content: "That number is not valid. Use `/reminders` to see your numbers!", allowedMentions: { parse: [] } });
            return;
        }
        let rec = rows[num-1];
        await db.run('DELETE FROM reminders WHERE id=?', rec.id);
        await interaction.reply({
            content: `⏰ Removed reminder #${num}: *${rec.content}* (was scheduled <t:${Math.floor(rec.remindAt/1000)}:R>)`,
            allowedMentions: { parse: [] }
        });
        // Re-schedule next
        scheduleReminders(client);
        return;
    }

    // --- Additional Feature: REMINDERSCLEAR: Remove ALL pending reminders from yourself (UX) ---
    if (interaction.isChatInputCommand && interaction.commandName === 'remindersclear') {
        const myReminders = await db.all('SELECT id FROM reminders WHERE userId=?', interaction.user.id);
        if (!myReminders.length) {
            await interaction.reply({ content: "You have no scheduled reminders to clear.", allowedMentions: { parse: [] } });
            return;
        }
        await db.run('DELETE FROM reminders WHERE userId=?', interaction.user.id);
        // UX: Show how many were cleared
        await interaction.reply({
            content: `✅ Cleared all your pending reminders (${myReminders.length} removed).`,
            allowedMentions: { parse: [] }
        });
        scheduleReminders(client); // reschedule future
        return;
    }













    // --- SLASH: WARN --- 
    if (interaction.isChatInputCommand() && interaction.commandName === 'warn') {
        // Permissions not required - all users are 'admin' for demonstration
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason').substring(0,300);
        await db.run('INSERT INTO warnings(userId, reason, timestamp) VALUES (?,?,?)',
            user.id, reason, Date.now());
        await interaction.reply({content:`⚠️ Warned ${user.tag}`, allowedMentions: { parse: [] }});

        try {
            await user.send(`[⚠️ Warning] From admins: ${reason}`);
        } catch{}
        return;
    }


    // --- SLASH: WARNINGS ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'warnings') {
        const tgt = interaction.options.getUser('user');
        // List all warnings for this user, let anyone delete by number - new UX (public moderation tool)
        let rows = await db.all('SELECT id, reason, timestamp FROM warnings WHERE userId=? ORDER BY id DESC LIMIT 10', tgt.id);
        if (rows.length === 0) {
            await interaction.reply({content:"No warnings for this user!", allowedMentions: { parse: [] }});
            return;
        }
        // Build delete buttons: one per warning
        const warnRows = rows.map((r, idx) => ({
            ...r,
            displayIndex: idx+1 // for public-facing numbering
        }));
        const embed = new EmbedBuilder()
            .setTitle(`${tgt.tag}'s last 10 warnings`)
            .setDescription(warnRows.map(w=>
                `**[${w.displayIndex}]** ${w.reason} _(at <t:${Math.floor(w.timestamp/1000)}:f>)_`
            ).join("\n"))
            .setColor(0xd13a29);
        // Add a button row only if there are warnings
        const actionRow = new ActionRowBuilder().addComponents(
            warnRows.map(w =>
                new ButtonBuilder()
                    .setCustomId(`delete_warning_${w.id}`)
                    .setLabel(`Delete #${w.displayIndex}`)
                    .setStyle(ButtonStyle.Danger)
            ).slice(0,5)
        );
        await interaction.reply({
            embeds:[embed],
            components: warnRows.length ? [actionRow] : [],
            allowedMentions: { parse: [] }
        });
        return;
    }


    // --- SLASH: CLEARWARNINGS ---
    if (interaction.isChatInputCommand() && interaction.commandName === "clearwarnings") {
        // Mass clear all warnings for a user
        const user = interaction.options.getUser('user');
        try {
            await db.run('DELETE FROM warnings WHERE userId=?', user.id);
            await interaction.reply({content: `All warnings for user ${user.tag} have been cleared.`, allowedMentions: { parse: [] }});
        } catch (e) {
            await interaction.reply({content:"Failed to clear warnings for this user.", allowedMentions: { parse: [] }});
        }
        return;
    }

    // --- SLASH: CLEARREACTIONS (admin-only UX improvement) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'clearreactions') {
        // Permissions not required - all users are 'admin' for demonstration
        let msgId = interaction.options.getString('message_id');
        if (!msgId) {
            await interaction.reply({content:"Please provide a message ID.", allowedMentions: { parse: [] }});
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
            await interaction.reply({content:"All thumbs up/down reactions cleared from that message (leaderboards should update).", allowedMentions: { parse: [] }});
        } catch(e) {
            await interaction.reply({content:"Failed to clear reactions. Check the message ID and try again.", allowedMentions: { parse: [] }});
        }

        return;
    }

    // --- SLASH: REMINDERSLOG (SHOW REMINDER HISTORY) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'reminderslog') {
        // Show public log of all sent reminders, newest first
        const rows = await db.all('SELECT userId, content, remindAt, sentAt FROM reminders_log ORDER BY sentAt DESC LIMIT 20');
        if (!rows.length) {
            await interaction.reply({content: 'No reminders have been sent yet!', allowedMentions: { parse: [] }});

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
        await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});
        return;
    }

    // --- ADDITIONAL FEATURE: REMINDER EXPORT/IMPORT ---

    if (interaction.isChatInputCommand && interaction.commandName === "reminderexport") {
        // Export all your reminders in a JSON blob (downloadable)
        let rows = await db.all('SELECT id, content, remindAt FROM reminders WHERE userId=? ORDER BY remindAt ASC', interaction.user.id);
        if (!rows.length) {
            await interaction.reply({ content: "You have no reminders to export.", allowedMentions: { parse: [] } });
            return;
        }
        // Export as a code block to allow easy copy-paste for import, or as a file attachment
        const jsonBlob = JSON.stringify(rows, null, 2);
        await interaction.reply({
            content: "Copy this JSON and save it to backup your reminders.\nYou can use `/reminderimport` later to restore them.\n```json\n" + jsonBlob + "\n```",
            allowedMentions: { parse: [] }
            // Note: If the file is long, can use file attachment API here for extra credit!
        });
        return;
    }

    // --- ADDITIONAL FEATURE: ARCHIVE COMMAND (export last 50 messages as file) ---
    if (interaction.isChatInputCommand && interaction.commandName === "archive") {
        try {
            // Get last 50 messages from message_logs
            const rows = await db.all("SELECT username, content, createdAt FROM message_logs ORDER BY createdAt DESC LIMIT 50");
            if (!rows.length) {
                await interaction.reply({ content: "No messages found to archive!", allowedMentions: { parse: [] } });
                return;
            }
            const lines = rows.reverse().map(r =>
                `[${new Date(r.createdAt).toLocaleString()}] [${r.username||"-"}]: ${r.content.replace(/\n/g," ")}`
            );
            const buffer = Buffer.from(lines.join("\n"), "utf8");
            // Save copy file into /data/ for demo trace/debug as well (timestamped filename)
            try {
                await fs.writeFile(DATA_DIR + `archive_${Date.now()}.txt`, lines.join("\n"));
            } catch {}
            await interaction.reply({
                content: "📄 Last 50 public messages attached.",
                files: [
                    { attachment: buffer, name: "archive_messages.txt" }
                ],
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({ content: "Failed to archive messages.", allowedMentions: { parse: [] } });
        }
        return;
    }

    if (interaction.isChatInputCommand && interaction.commandName === "reminderimport") {
        // Import reminders from pasted JSON array
        let jsonTxt = interaction.options.getString("json");
        let arr;
        try {
            arr = JSON.parse(jsonTxt);
        } catch(e) {
            await interaction.reply({ content: "Failed to parse your JSON. Make sure it's a proper exported array!", allowedMentions: { parse: [] } });
            return;
        }
        if (!Array.isArray(arr) || !arr.length || !arr.every(x => typeof x.content === "string" && typeof x.remindAt === "number")) {
            await interaction.reply({ content: "Invalid format. Provide an array of reminders as exported!", allowedMentions: { parse: [] } });
            return;
        }
        // Only import up to 100 at a time for sanity
        let count = 0, now = Date.now();
        for (const item of arr) {
            if (!item.content || typeof item.remindAt !== "number" || item.remindAt < now) continue; // skip past-due
            if (++count > 100) break; // limit
            await db.run('INSERT INTO reminders(userId, content, remindAt) VALUES (?,?,?)', interaction.user.id, item.content.substring(0,200), item.remindAt);
        }
        if (count)
            await interaction.reply({ content: `✅ Imported ${count} reminders!`, allowedMentions: { parse: [] } });
        else
            await interaction.reply({ content: "No valid, future reminders found to import.", allowedMentions: { parse: [] } });
        scheduleReminders(client);
        return;
    }




    // --- SLASH: PURGE with Confirmation and Cooldown ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'purge') {
        // Permissions not required - all users are 'admin' for demonstration
        // Safety Cooldown
        if (!client._purgeCooldown) client._purgeCooldown = {};
        const lastT = client._purgeCooldown[interaction.user.id]||0;
        if (Date.now()-lastT < 60000)
            return void interaction.reply({content:`Please wait before purging again for safety. (${Math.ceil((60000-(Date.now()-lastT))/1000)}s left)`, allowedMentions: { parse: [] }});

        let n = interaction.options.getInteger('count');
        if (n<1 || n>50) {
            await interaction.reply({content:'Count must be 1-50.', allowedMentions: { parse: [] }});
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
                await interaction.reply({content:'No XP on record.', allowedMentions: { parse: [] }});

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
                await interaction.reply({embeds: [embed], allowedMentions: { parse: [] }});
            }
        } catch(e) {
            await interaction.reply({content:'Sorry, there was an error fetching your XP/Level.', allowedMentions: { parse: [] }});
        }
        return;
    }

    // --- ADDITIONAL FEATURE: PIN MESSAGE IN CHANNEL ---
    if (interaction.isChatInputCommand() && interaction.commandName === "pin") {
        // Only allow in main channel
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content: "Use this command in the main channel only.", allowedMentions: { parse: [] }});
            return;
        }
        let msgId = interaction.options.getString("message_id");
        let note = interaction.options.getString("note") || "";
        if (!msgId) {
            await interaction.reply({content: "You must provide a message ID.", allowedMentions: { parse: [] }});
            return;
        }
        // Try to fetch the message and pin it
        try {
            const chan = await client.channels.fetch(CHANNEL_ID);
            const msg = await chan.messages.fetch(msgId);
            await db.run(
                'INSERT INTO pinned_messages(messageId, pinnerId, note, pinnedAt) VALUES (?,?,?,?)',
                msgId, interaction.user.id, note, Date.now()
            );
            // Success UX: Provide confirmation with content snippet
            let snippet = (msg.content || '').slice(0, 120);
            let uname;
            try {
                let userObj = await client.users.fetch(interaction.user.id);
                uname = userObj.username;
            } catch { uname = interaction.user.id; }
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`📌 Message pinned successfully!`)
                        .setDescription([
                            `**Content:**\n${snippet ? `> ${snippet}` : "*[no content/attachment]*"}`,
                            note ? `**Note:** ${note}` : "",
                            `Pinned by: ${uname}`
                        ].filter(Boolean).join("\n"))
                        .setFooter({ text: `Message ID: ${msgId} | Use /pinned to see all.` })
                        .setURL(msg.url || undefined)
                        .setColor(0xfbb034)
                ],
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({content: "Could not pin the message. Check the message ID.", allowedMentions: { parse: [] }});
        }
        return;
    }

    // --- ADDITIONAL FEATURE: VIEW PINNED MESSAGES SLASH COMMAND ---
    if (interaction.isChatInputCommand() && interaction.commandName === "pinned") {
        // List last 10 pins, show in embed, with IDs and jump links where possible
        try {
            let pins = await db.all("SELECT * FROM pinned_messages ORDER BY pinnedAt DESC LIMIT 10");
            if (!pins || pins.length === 0) {
                await interaction.reply({content: "No messages pinned yet! Pin one using `/pin`.", allowedMentions: { parse: [] }});
                return;
            }
            const chan = await client.channels.fetch(CHANNEL_ID);
            let desc = "";
            for (let i = 0; i < pins.length; ++i) {
                let pi = pins[i];
                let uname;
                try {
                    let user = await client.users.fetch(pi.pinnerId);
                    uname = user.username;
                } catch { uname = pi.pinnerId; }
                let msgContent = "";
                let jumplink = "";
                try {
                    let m = await chan.messages.fetch(pi.messageId);
                    msgContent = m.content ? m.content.slice(0,80) : "*[no content/attachment]*";
                    jumplink = m.url ? `[jump](${m.url})` : "";
                } catch {
                    msgContent = "*[deleted/unavailable]*";
                }
                desc += `**[${i + 1}]** ${uname} pinned: "${msgContent}" ${jumplink}`;
                if (pi.note) desc += `\nNote: ${pi.note}`;
                desc += "\n";
            }
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("📌 Pinned Messages in this Channel")
                        .setDescription(desc)
                        .setColor(0xfbb034)
                ],
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({content:"Failed to show pinned messages.", allowedMentions: { parse: [] }});
        }
        return;
    }





    // --- SLASH: DICESTREAK ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'dicestreak') {
        // Show longest dice roll streaks (consecutive days with any roll) for all users
        try {
            let histAll = [];
            try { histAll = await readJSONFile("roll_history.json", []); } catch {}
            if (!histAll.length) {
                await interaction.reply({
                    content: "No dice roll history yet!",
                    allowedMentions: { parse: [] }
                });
                return;
            }
            // Compute for each userId: count max "consecutive days with roll"
            let byUid = {};
            for (let r of histAll) {
                if (!byUid[r.userId]) byUid[r.userId] = [];
                byUid[r.userId].push(r.at);
            }
            let streakStats = [];
            for (let [uid, ats] of Object.entries(byUid)) {
                let days = ats.map(x=>Math.floor(x/86400000));
                days = [...new Set(days)].sort((a,b)=>a-b);
                let maxStreak = 0, cur = 1;
                for (let i=1;i<days.length;i++) {
                    if (days[i] === days[i-1]+1) cur++;
                    else cur = 1;
                    if (cur>maxStreak) maxStreak = cur;
                }
                if (days.length) maxStreak = Math.max(maxStreak, 1);
                streakStats.push({ uid, maxStreak, days: days.length });
            }
            streakStats = streakStats.sort((a,b)=>b.maxStreak - a.maxStreak).slice(0, 10);
            // Fetch usernames
            for (let stat of streakStats) {
                try {
                    let user = await client.users.fetch(stat.uid);
                    stat.uname = user?.username || stat.uid;
                } catch { stat.uname = stat.uid; }
            }
            let desc = streakStats.map((s, i)=>
                `#${i+1}: **${s.uname}** — Best streak: **${s.maxStreak} day${s.maxStreak===1?'':'s'}**, Total active days: ${s.days}`
            ).join("\n");
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🎲 Dice Roll Streak Leaderboard")
                        .setDescription("Top dice roll daily streaks across all users.\n\n" + desc)
                        .setColor(0x81e6d9)
                ],
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({content: "Failed to compute dice streaks.", allowedMentions: { parse: [] }});
        }
        return;
    }

    // --- SLASH: ROLL ---
// UX improvement: more robust/clear error for empty input; add special "roll for initiative" preset

    // --- [ADDITIONAL FEATURE: CALC SLASH COMMAND IMPLEMENTATION] ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'calc') {

        // Calculate a user-provided math expression safely
        const expression = interaction.options.getString('expression');
        // Input sanitization: only allow numbers, + - * / ( ) . ^ and spaces
        if (!/^[\d\s\+\-\*\/\(\)\.\^]+$/.test(expression)) {
            await interaction.reply({content: 'Invalid characters. Only numbers, (+-*/.^), parentheses, and spaces allowed.', allowedMentions: { parse: [] }});
            return;
        }
        try {
            // Replace '^' with '**' for exponentiation, then eval
            const safeExpr = expression.replace(/\^/g, '**');
            // eslint-disable-next-line no-eval
            let result = eval(safeExpr);
            // Provide math breakdown for common cases, else show raw result
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🧮 Calculation Result")
                        .setDescription(`\`${expression}\` = **${result}**`)
                        .setColor(0x47d677)
                ],
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({content: 'Failed to calculate. Double-check your math!', allowedMentions: { parse: [] }});
        }
        return;
    }
    // --- ADDITIONAL FEATURE: ANNOUNCE COMMAND ---
    // Allow any user to post an announcement in the main channel as an embed (public utility)
    if (interaction.isChatInputCommand() && interaction.commandName === 'announce') {
        // Only allow in main channel (single-guild restriction)
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({content: "Announcements are public in the main channel. Use this command there!", allowedMentions: { parse: [] }});
            return;
        }
        let title = interaction.options.getString('title')?.substring(0, 120).trim();
        let message = interaction.options.getString('message')?.substring(0, 900).trim();
        if (!title || !message) {
            await interaction.reply({content: "You must provide both a title and a message!", allowedMentions: { parse: [] }});
            return;
        }
        const embed = new EmbedBuilder()
            .setTitle("📢 " + title)
            .setDescription(message)
            .setFooter({ text: `Announced by ${interaction.user.username}` })
            .setColor(0xeab308)
            .setTimestamp();
        // Announcement as a normal message (no ephemeral!)
        await interaction.reply({embeds: [embed], allowedMentions: { parse: [] }});
        // UX: Save to local history for reference (optional, keep only recent 20 for space)
        try {
            let ann = await readJSONFile("announcements.json", []);
            ann.push({
                title,
                message,
                by: interaction.user.id,
                at: Date.now()
            });
            if (ann.length > 20) ann = ann.slice(-20);
            await saveJSONFile("announcements.json", ann);
        } catch {}
        return;
    }


    if (interaction.isChatInputCommand() && interaction.commandName === "suggest") {
        // Suggestion feature: add suggestion to db and post it for voting
        const text = interaction.options.getString("text")?.trim();
        if (!text || text.length < 4) {
            await interaction.reply({content: "Suggestion too short! Please provide more details.", allowedMentions: { parse: [] }}); return;
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
            // Remove mention from footer (use username instead)
            .setFooter({ text: `By ${interaction.user.username} | Use /suggestions to vote or comment!` })
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
        await interaction.reply({embeds: [embed], components: [row], allowedMentions: { parse: [] }});
        return;
    }


    if (interaction.isChatInputCommand() && interaction.commandName === "suggestions") {
        // List all open suggestions, mark those handled with [HANDLED], UX improvement
        let recs = await db.all(
            "SELECT * FROM suggestion WHERE status='pending' OR status='approved' OR status='handled' ORDER BY createdAt DESC LIMIT 10"
        );
        if (!recs.length) {
            await interaction.reply({content: "No suggestions yet! Use `/suggest` to add one.", allowedMentions: { parse: [] }});
            return;
        }

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
        let embeds = [];
        // Fetch usernames upfront to remove mention in description
        let userNameCache = {};
        for (const e of entries.slice(0,3)) {
            let uname = e.userId;
            try {
                let uobj = await client.users.fetch(e.userId);
                uname = uobj.username;
            } catch {}
            embeds.push(
                new EmbedBuilder()
                    .setTitle(`${e.handled ? "✅ [HANDLED]" : ""} Suggestion #${e.id}${e.category?` (${e.category})`:""}`)
                    .setDescription([
                        `> ${e.suggestion}`,
                        `By: ${uname}`,
                        `Status: \`${e.status}\`${e.handled ? " (Marked as handled)" : ""}`,
                        `👍 ${e.up} | 👎 ${e.down}`
                    ].join("\n"))
                    .setColor(e.handled ? 0x34d399 : 0xf9a825)
                    .setFooter({ text: `Use /suggest to add your own!` })
                    .setTimestamp(e.createdAt)
            );
        }
        await interaction.reply({embeds: embeds});
        return;
    }





    // --- SLASH: SUGGESTHANDLE ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'suggesthandle') {
        // No permissions needed per restrictions
        let sid = interaction.options.getInteger('suggestion_id');
        let stat = interaction.options.getString('status');
        let validStatus = ["approved", "rejected", "handled"];
        if (!sid || !stat || !validStatus.includes(stat)) {
            await interaction.reply({content:"Invalid suggestion ID or status.", allowedMentions: { parse: [] }});
            return;
        }
        let row = await db.get("SELECT * FROM suggestion WHERE id=?", sid);

        if (!row) {
            await interaction.reply({content:"No such suggestion.", allowedMentions: { parse: [] }});
            return;
        }

        // Minor improvement: mark handled column and update status, provide option for admin to set category as well (modal)
        await db.run("UPDATE suggestion SET status=?, handled=1 WHERE id=?", stat, sid);

        // After marking as handled, allow admin to tag category for organize UX via modal
        if (stat === "approved" || stat === "handled") {
            const modal = new ModalBuilder()
                .setTitle('Tag Suggestion (optional)')
                .setCustomId('suggest_category_modal')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('category')
                        .setLabel('Add category/tag for this suggestion (optional)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                    )
                );
            client._suggestHandleTemp = {sid};
            await interaction.showModal(modal);

            client.once('interactionCreate', async modalInter => {
                if (!modalInter.isModalSubmit() || modalInter.customId!=='suggest_category_modal') return;
                let cat = modalInter.fields.getTextInputValue('category');
                if (cat && cat.length>=2) await db.run("UPDATE suggestion SET category=? WHERE id=?", cat, sid);
                await modalInter.reply({content: `Suggestion #${sid} marked as **${stat}**${cat?` in category \`${cat}\``:""}.`, allowedMentions: { parse: [] }});
            });
        } else {
            await interaction.reply({content: `Suggestion #${sid} marked as **${stat}** (Handled).`, allowedMentions: { parse: [] }});
        }
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
                await interaction.reply({content:"Invalid dice formula. Example: **1d20**, **2d6+3**, up to 100 dice (sides 2-1000). \nTry `/roll 2d10+1` or use quick buttons:", components: [rrow], allowedMentions: { parse: [] }});

                return;
            }

            let num = parseInt(m[1] || "1",10);
            let sides = parseInt(m[2],10);
            let modifier = 0;
            let modmatches = (m[3]||"").match(/[+-]\d+/g);
            if (modmatches) for (let mod of modmatches) modifier += parseInt(mod,10);

            if (isNaN(num) || num<1 || num>100 || isNaN(sides) || sides<2 || sides>1000) {
                await interaction.reply({content:"Dice count must be 1-100; sides 2-1000.", allowedMentions: { parse: [] }}); return;

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
                await interaction.reply({content:"An error occurred while rolling dice.", allowedMentions: { parse: [] }});

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
            if (!hist.length) return void interaction.reply({content:"No dice roll history found.", allowedMentions: { parse: [] }});


            let lines = hist.map((h,i) => `**${i+1}.** \`${h.formula}\` = ${h.resultMsg} _(at <t:${Math.floor(h.at/1000)}:t>)_`);
            let embed = new EmbedBuilder()
                .setTitle(`${interaction.user.tag}'s Last ${hist.length} Dice Rolls`)
                .setDescription(lines.join("\n"))
                .setColor(0x7dd3fc);
            await interaction.reply({embeds:[embed]});
        } catch (e) {
            await interaction.reply({content:"Failed to show roll history.", allowedMentions: { parse: [] }});

        }
        return;
    }

    // --- SLASH: ROLLSTATS ---
    if (interaction.isChatInputCommand && interaction.commandName === "rollstats") {
        try {
            let histAll = [];
            try { histAll = await readJSONFile("roll_history.json", []); } catch {}
            if (!histAll.length) return void interaction.reply({content:"No roll stats yet!", allowedMentions: { parse: [] }});


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
            await interaction.reply({content:"Failed to compute roll stats.", allowedMentions: { parse: [] }});

        }
        return;
    }



    // --- SLASH: DICE WAR (fun quick duel game) ---
    if (interaction.isChatInputCommand() && interaction.commandName === "dicewar") {
        const opponent = interaction.options.getUser("opponent");
        if (!opponent || opponent.bot || opponent.id === interaction.user.id) {
            await interaction.reply({content: "Please challenge a real user (not yourself/bot)!", allowedMentions: { parse: [] }});

            return;
        }
        if (client._ongoingDiceWar && client._ongoingDiceWar[interaction.user.id]) {

            await interaction.reply({ content: `You already have a pending Dice War challenge! Wait for it to finish.`, allowedMentions: { parse: [] } });

            return;
        }
        if (client._ongoingDiceWar && client._ongoingDiceWar[opponent.id]) {
            await interaction.reply({ content: `That user is already in a Dice War! Try again later.`, allowedMentions: { parse: [] } });

            return;
        }

        // Store challenge context (5min expiry)
        client._ongoingDiceWar = client._ongoingDiceWar || {};
        client._ongoingDiceWar[opponent.id] = {
            challenger: interaction.user.id,
            challenged: opponent.id,
            startTime: Date.now(),
            messageId: null,
            accepted: false
        };
        const challengeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dicewar_accept_${interaction.user.id}`).setLabel("Accept Duel!").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dicewar_decline_${interaction.user.id}`).setLabel("Decline").setStyle(ButtonStyle.Danger)
        );
        const challengeMsg = await interaction.reply({
            content: `<@${opponent.id}>, you have been challenged to a **Dice War** by <@${interaction.user.id}>!`,
            embeds: [
                new EmbedBuilder()
                    .setTitle("🎲 Dice War Challenge!")
                    .setDescription("<@"+opponent.id+">, do you accept this head-to-head dice duel?\nEach of you rolls 1d20. Highest wins! Draw is a rematch.")
                    .setColor(0x84cc16)
            ],
            components: [challengeRow]
        });
        // Save the message id to match on button click
        client._ongoingDiceWar[opponent.id].messageId = challengeMsg.id;
        setTimeout(()=>{
            // Timeout - auto cancel challenge after 5 mins
            if (client._ongoingDiceWar && client._ongoingDiceWar[opponent.id] && !client._ongoingDiceWar[opponent.id].accepted) {
                client._ongoingDiceWar[opponent.id] = undefined;
            }
        }, 5*60*1000);
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
            ],
            allowedMentions: { parse: [] }
        });
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
        await interaction.reply({embeds: [embed], allowedMentions: { parse: [] }});
        return;
    }











    // --- SLASH: DICE WAR LEADERBOARD ---
    if (interaction.isChatInputCommand() && interaction.commandName === "dicewarleaderboard") {
        let score = await readJSONFile("dicewar_leader.json", []);
        if (!score.length)
            return void interaction.reply({content:"No Dice War games played yet.", allowedMentions: { parse: [] }});

        let lines = [];
        // Try to resolve usernames
        for (let i=0;i<score.length;i++) {
            let s = score[i];
            let tag = s.userId;
            try {
                let user = await client.users.fetch(s.userId);
                tag = user.tag;
            } catch {}
            lines.push(`**#${i+1} <@${s.userId}> (${tag})** — ${s.wins} wins`);
        }
        lines = lines.sort((a,b)=>b.wins-a.wins).slice(0,5);
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("🎲 Dice War Leaderboard")
                    .setDescription(lines.join('\n'))
                    .setColor(0x2dd4bf)
            ]
        });
        return;
    }

    // --- SLASH: LEADERBOARD ---

    if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
        const lines = [];
        const xpRows = await db.all('SELECT userId, xp, level FROM xp ORDER BY level DESC, xp DESC LIMIT 10');
        let totalMsgs = await db.get('SELECT COUNT(*) as n FROM message_logs');
        let topMsgRows = await db.all(`
            SELECT userId, COUNT(*) as msgcount
            FROM message_logs
            GROUP BY userId
            ORDER BY msgcount DESC
            LIMIT 5
        `);
        if (!xpRows.length) return void interaction.reply({content:"Leaderboard empty.",ephemeral:true, allowedMentions: { parse: [] }});
        lines.push("**__XP & Level Top 10__**");
        for (let i=0;i<xpRows.length;++i) {
            const r = xpRows[i];
            let tagRec;
            try {
                tagRec = await db.get('SELECT tag FROM user_tags WHERE userId=?', r.userId);
            } catch {}
            let username = tagRec && tagRec.tag ? tagRec.tag : r.userId;
            lines.push(`**#${i+1}: ${username}** — Level ${r.level} (${r.xp} XP)`);
        }
        if (topMsgRows && topMsgRows.length) {
            lines.push("\n__Top Active Chatters:__");
            for (let i=0; i<topMsgRows.length; ++i) {
                let user;
                try {
                    let fres = await client.users.fetch(topMsgRows[i].userId);
                    user = fres?.username || topMsgRows[i].userId;
                } catch { user = topMsgRows[i].userId; }
                lines.push(`#${i+1}: ${user} — ${topMsgRows[i].msgcount} msgs`);
            }
        }
        lines.push(`\n_Total messages logged_: **${totalMsgs?.n||0}**`);
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("Leaderboard & Top Active Users")
                    .setDescription(lines.join("\n"))
                    .setColor(0xbafcfa)
            ],
            allowedMentions: { parse: [] }
        });
        return;
    }




    // --- SLASH: 8BALL ---
    if (interaction.isChatInputCommand() && interaction.commandName === '8ball') {
        const q = interaction.options.getString('question');
        const reply = eightBallResponses[Math.floor(Math.random()*eightBallResponses.length)];
        await interaction.reply({content:`🎱 *Q: ${q}*\nA: **${reply}**`, ephemeral:false, allowedMentions: { parse: [] }});
        return;
    }

    // --- ADDITIONAL FEATURE: MSGSEARCH ---
    if (interaction.isChatInputCommand() && interaction.commandName === "msgsearch") {
        let keyword = interaction.options.getString("keyword").toLowerCase().trim();
        if (!keyword || keyword.length < 2) {
            await interaction.reply({content: "Please enter a longer search keyword.", allowedMentions: { parse: [] }});
            return;
        }
        try {
            // Search message_logs for content that matches (visible to all, only last 50 for safety)
            let found = await db.all(
                "SELECT username, content, createdAt FROM message_logs WHERE content LIKE ? ORDER BY createdAt DESC LIMIT 10",
                `%${keyword}%`
            );
            if (!found.length) {
                await interaction.reply({content: `No previous messages found containing "${keyword}".`, allowedMentions: { parse: [] }});
                return;
            }
            // Display formatted embed
            let embed = new EmbedBuilder()
                .setTitle(`🔍 Message Search for "${keyword}"`)
                .setDescription(found.map((m, i) =>
                    `**#${i+1}** [${m.username||"-"}] — _${m.content.slice(0, 120)}_ (<t:${Math.floor(m.createdAt/1000)}:R>)`
                ).join("\n"))
                .setFooter({text: `Showing last ${found.length} matches`})
                .setColor(0x39a5a4);
            await interaction.reply({embeds: [embed], allowedMentions: { parse: [] }});
        } catch (e) {
            await interaction.reply({content: "Failed to perform search (db error).", allowedMentions: { parse: [] }});
        }
        return;
    }




    // --- SLASH: SNIPE ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'snipe') {
        const lastDeleted = await db.get('SELECT * FROM message_logs WHERE deleted=1 ORDER BY createdAt DESC LIMIT 1');
        if (!lastDeleted) return void interaction.reply({content:"No deleted messages found.", allowedMentions: { parse: [] }});

        const embed = new EmbedBuilder()
            .setTitle("🕵️ Last Deleted Message")
            .setDescription(lastDeleted.content || "*[no content]*")
            .setFooter({text: `By ${lastDeleted.username || lastDeleted.userId}`})
            .setTimestamp(lastDeleted.createdAt || Date.now());
        // Add jump link if possible
        if (lastDeleted.guildId && lastDeleted.channelId && lastDeleted.messageId)
          embed.setURL(`https://discord.com/channels/${lastDeleted.guildId}/${lastDeleted.channelId}/${lastDeleted.messageId}`);
        await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});
        return;
    }

    // --- NEW FEATURE: RECENT MESSAGES SLASH COMMAND ---
    if (interaction.isChatInputCommand && interaction.commandName === 'recent') {
        try {
            // Fetch last 10 messages from message_logs
            let recents = await db.all(
                "SELECT username, content, createdAt FROM message_logs ORDER BY createdAt DESC LIMIT 10"
            );
            if (!recents.length) {
                await interaction.reply({content: "No recent messages found.", allowedMentions: { parse: [] }});
                return;
            }
            const embed = new EmbedBuilder()
                .setTitle("🕑 Recent Messages")
                .setDescription(recents.map((r, i) =>
                    `**#${recents.length-i}** [${r.username||"-"}] — _${r.content.slice(0, 120)}_ (<t:${Math.floor(r.createdAt/1000)}:R>)`
                ).join("\n"))
                .setFooter({text: "Last 10 public messages"})
                .setColor(0x3b82f6);
            await interaction.reply({embeds: [embed], allowedMentions: { parse: [] }});
        } catch (e) {
            await interaction.reply({content: "Failed to show recent messages.", allowedMentions: { parse: [] }});
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
            ],
            allowedMentions: { parse: [] }
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
        // Additional: Most rated fun fact
        let ffRatings = [];
        try { ffRatings = await readJSONFile("funfacts_ratings.json", []); } catch {}
        let bestFF = "";
        if (ffRatings.length) {
            let top = ffRatings
                .filter(r=>r.ratings && r.ratings.length >= 3)
                .map(r=>({
                    ...r,
                    avg: r.ratings.reduce((a,b)=>a+b.value,0)/r.ratings.length
                }))
                .sort((a, b) => b.avg - a.avg)[0];
            if (top) {
                bestFF = `Best fun fact (by rating): "${top.fact}" (${top.author}, avg ${(top.avg||0).toFixed(2)})`;
            }
        }
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
        if (bestFF) embed.addFields({ name: "🏆", value: bestFF });
        await interaction.reply({embeds:[embed], ephemeral:false});
        return;
    }

    // --- FUNFACT RATING BUTTON HANDLER (new feature) ---
    if (interaction.isButton() && /^funfact_rate_\d$/.test(interaction.customId)) {
        // Find the last fun fact in funfacts_ratings.json with this fact and add the user's rating (no duplicate per user/fact)
        let ratingNumber = parseInt(interaction.customId.split("_")[2]);
        if (isNaN(ratingNumber) || ratingNumber < 1 || ratingNumber > 5) {
            await interaction.reply({ content: "Invalid rating.", allowedMentions: { parse: [] } });
            return;
        }
        try {
            let ffRatings = await readJSONFile("funfacts_ratings.json", []);
            // Try to find the last rating entry in the past 2min (to avoid accidental mixing batches)
            const now = Date.now();
            let idx = ffRatings.findIndex(
                f => (now - f.at < 2*60*1000)
                    && f.fact
                    && (interaction.message?.embeds?.[0]?.description?.includes(f.fact))
            );
            if (idx === -1) {
                // Fallback: try match fact string exactly from embed
                let factText = interaction.message?.embeds?.[0]?.description?.replace(/"/g,"").trim() || "";
                idx = ffRatings.findIndex(f => f.fact === factText);
            }
            if (idx === -1) {
                await interaction.reply({ content: "Could not match this fact for rating!", allowedMentions: { parse: [] } });
                return;
            }
            if (ffRatings[idx].ratings.find(r => r.userId === interaction.user.id)) {
                await interaction.reply({ content: "You already rated this fun fact!", allowedMentions: { parse: [] } });
                return;
            }
            ffRatings[idx].ratings.push({ userId: interaction.user.id, value: ratingNumber, at: now });
            await saveJSONFile("funfacts_ratings.json", ffRatings);
            // UX: compute new avg for this fact and thank
            const avg = ((ffRatings[idx].ratings.reduce((a,b)=>a+b.value,0))/ffRatings[idx].ratings.length).toFixed(2);
            await interaction.reply({
                content: `Thank you for your rating! This fact's average is now ${avg} (${ffRatings[idx].ratings.length} ratings).`,
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({ content: "Failed to save rating. Please try again.", allowedMentions: { parse: [] } });
        }
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


/* --- SLASH: STICKY (moved here for single on-interaction handler) ---
   [UX fix: remove @ mentions from sticky message announcement, use username]
*/
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
            // Fetch username, fallback to userId
            let uname;
            try {
                let user = await client.users.fetch(interaction.user.id);
                uname = user.username;
            } catch { uname = interaction.user.id; }
            await chan.send({
                content: `__**Sticky Message**__\n${msg}\n*(set by ${uname})*`,
                allowedMentions: { parse: [] }
            });
        } catch{}
        return;
    }
});




client.on('messageCreate', async msg => {
    // Restrict to the one allowed channel (except for DMs)
    if (msg.guild && msg.channel.id !== CHANNEL_ID) return;
    if (msg.author.bot) return;

    // --- Fix: Disallow user/role/everyone mentions in sent messages (forced allowedMentions global) ---
    if (
        (msg.mentions?.users && msg.mentions.users.size > 0) ||
        (msg.mentions?.roles && msg.mentions.roles.size > 0) ||
        msg.mentions?.everyone
    ) {
        // Remove all mentions from message, auto-remove for compliance (UX: warning, but auto-resolve)
        try { await msg.delete(); } catch {}
        await msg.channel.send({content:"Mentions are disabled for this bot. Do not mention users, roles, or everyone.", allowedMentions: { parse: [] }});
        return;
    }


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
                    // Fetch username for UX
                    let uname;
                    try {
                        let u = await client.users.fetch(stickyRec.setBy);
                        uname = u.username;
                    } catch { uname = stickyRec.setBy; }
                    let m = await msg.channel.send({
                        content: `__**Sticky Message**__\n${stickyRec.message}\n*(set by ${uname})*`,
                        allowedMentions: { parse: [] }
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
        await msg.reply({content: responses[Math.floor(Math.random()*responses.length)], allowedMentions: { parse: [] }});

        // User XP up for interacting directly with bot/tag
        const row = await db.get('SELECT xp, level FROM xp WHERE userId=?', msg.author.id) || {xp:0,level:0};
        let xpAdd = Math.floor(Math.random()*5)+5; // boost for bot interaction
        let xpNow = row.xp + xpAdd;

        // --- Fix: (Forced) allowedMentions parse: [] in all outgoing .reply from here on ---

        let lvlNow = row.level;
        if(xpNow >= (row.level+1)*100) { xpNow=0; lvlNow++; }
        await db.run('INSERT OR REPLACE INTO xp(userId, xp, level) VALUES (?,?,?)',
            msg.author.id, xpNow, lvlNow);
        if (lvlNow > row.level)
            await msg.reply({content:`🌟 You leveled up to ${lvlNow}!`, allowedMentions: { parse: [] }});



    }

    // --- Log all messages for moderation/stats ---
    if (msg.guild) {
        await db.run('INSERT INTO message_logs(userId, username, content, createdAt, guildId, channelId, messageId) VALUES (?,?,?,?,?,?,?)',
            msg.author.id, (msg.member?.user?.tag || msg.author.username), msg.content, Date.now(), msg.guild.id, msg.channel.id, msg.id);
        lastMessageUserCache[msg.author.id] = { username: msg.member?.user?.tag || msg.author.username };
    }

    // --- NEW FEATURE: AUTOREACT TO "GG" IN MESSAGES, AND TRACK GGs ---
    // If a message contains "gg" (case-insensitive, and not a bot), react with 👏 and save to gg table.
    // Shows public fun leaderboard on /gg or /ggleaderboard
    if (msg.guild) {
        if (/(^|\s)gg(!|$|\s)/i.test(msg.content) && !msg.author.bot) {
            // React with 👏
            try { await msg.react('👏'); } catch {}
            // Save to ggrecords table (upsert or add), counting per-user "gg" count.
            await db.run("CREATE TABLE IF NOT EXISTS ggrecords (userId TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)");
            let row = await db.get("SELECT count FROM ggrecords WHERE userId=?", msg.author.id);
            if (row) {
                await db.run("UPDATE ggrecords SET count = count+1 WHERE userId=?", msg.author.id);
            } else {
                await db.run("INSERT INTO ggrecords(userId,count) VALUES (?,1)", msg.author.id);
            }
        }
    }


    // Don't run in DMs except for reminders/notes slash cmds
    // XP, content moderation, games: only in main channel
    if (msg.guild) {
        // XP: 3-10/message, 1 min cooldown unless XP muted for this user (content moderation improvement)
        let muted = null;
        // First, check user_settings table for muted XP state:
        try {
            let userSetting = await db.get("SELECT mute_xp FROM user_settings WHERE userId=?", msg.author.id);
            if (userSetting && userSetting.mute_xp) muted = true;
        } catch {}
        // If no mute detected above, fallback to legacy warnings table check:
        if (!muted) try { muted = await db.get("SELECT 1 FROM warnings WHERE userId=? AND reason LIKE '%XP MUTE%'", msg.author.id); } catch {}
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
                    await msg.reply({content:`🌟 You leveled up to ${lvlNow}!`, allowedMentions: { parse: [] }});

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
            await msg.reply({content:"🚫 Message removed for inappropriate language.", allowedMentions: { parse: [] }});



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
            await msg.reply({content: "Detected code — save to notes?", components: [row], allowedMentions: { parse: [] }});

        }
    }

});



client.on('interactionCreate', async interaction => {
    

// --- POLL & DICE-GAME BUTTON HANDLERS ---
    // --- DICE WAR BUTTONS ---
    if (
        interaction.isButton() &&
        (
            /^dicewar_accept_/.test(interaction.customId) ||
            /^dicewar_decline_/.test(interaction.customId)
        )
    ) {
        // Only the challenged user can click
        // Accept or decline dice duel
        let challengerId = interaction.customId.split("_")[2];
        let challengedId = interaction.user.id;
        if (!client._ongoingDiceWar || !client._ongoingDiceWar[challengedId]) {
            await interaction.reply({content:"No pending Dice War challenge for you!"});
            return;
        }
        if (interaction.customId.startsWith("dicewar_accept_")) {
            // Accept - roll dice for both and resolve
            client._ongoingDiceWar[challengedId].accepted = true;
            let rollA = Math.floor(Math.random()*20)+1;
            let rollB = Math.floor(Math.random()*20)+1;
            let userA = challengerId, userB = challengedId;
            let winner, loser, draw = false;
            if (rollA === rollB) {
                draw = true;
            } else if (rollA > rollB) {
                winner = userA;
                loser = userB;
            } else {
                winner = userB;
                loser = userA;
            }
            let resDesc = `<@${userA}> rolled **${rollA}**\n<@${userB}> rolled **${rollB}**\n`;
            if (draw) {
                resDesc += "\n🤝 It's a draw! Rematch by using `/dicewar` again.";
            } else {
                resDesc += `\n🏆 <@${winner}> wins the Dice War! Better luck next time, <@${loser}>.`;
            }
            try {
                // Update original challenge message
                if (client._ongoingDiceWar[challengedId].messageId) {
                    let chan = await client.channels.fetch(CHANNEL_ID);
                    let msg = await chan.messages.fetch(client._ongoingDiceWar[challengedId].messageId);
                    await msg.edit({
                        embeds: [new EmbedBuilder().setTitle("🎲 Dice War Result!").setDescription(resDesc).setColor(0xfbbf24)],
                        components: []
                    });
                }
            } catch {}
            await interaction.reply({
                embeds: [new EmbedBuilder().setTitle("🎲 Dice War Result!").setDescription(resDesc).setColor(0xfbbf24)],
                components: []
            });
            // Optionally: store in file leaderboard /data/dicewar_leader.json
            try {
                let score = await readJSONFile("dicewar_leader.json", []);
                if (!draw) {
                    let idx = score.findIndex(x=>x.userId===winner);
                    if (idx<0) score.push({userId:winner, wins:1});
                    else score[idx].wins +=1;
                    await saveJSONFile("dicewar_leader.json", score);
                }
            } catch {}
            client._ongoingDiceWar[challengedId] = undefined;
        } else {
            // Decline
            try {
                if (client._ongoingDiceWar[challengedId].messageId) {
                    let chan = await client.channels.fetch(CHANNEL_ID);
                    let msg = await chan.messages.fetch(client._ongoingDiceWar[challengedId].messageId);
                    await msg.edit({
                        embeds: [
                            new EmbedBuilder().setTitle("🎲 Dice War Challenge").setDescription(`<@${challengedId}> declined the challenge from <@${challengerId}>!`).setColor(0xfca5a5)
                        ],
                        components: []
                    });
                }
            } catch {}
            await interaction.reply({content:`You declined the Dice War challenge from <@${challengerId}>.`});
            client._ongoingDiceWar[challengedId] = undefined;
        }
        return;
    }
    // --- DICE ROLL BUTTONS (roll again, quick roll, leaderboard) ---
    if (interaction.isButton() && (
        /^replay_roll_/.test(interaction.customId) ||
        /^quickroll_(d6|d20)/.test(interaction.customId) ||
        /^roll_leaderboard$/.test(interaction.customId) ||
        /^daily_leaderboard$/.test(interaction.customId)
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
                await interaction.reply({content:"Failed to compute roll stats.", allowedMentions: { parse: [] }});

            }

            return;
        }
        if (/^daily_leaderboard$/.test(interaction.customId)) {
            // Reuse leaderboard code from /dailyleaderboard
            try {
                await db.run(`CREATE TABLE IF NOT EXISTS daily_rewards (
                    userId TEXT NOT NULL,
                    lastClaim INTEGER NOT NULL,
                    streak INTEGER NOT NULL DEFAULT 0,
                    bestStreak INTEGER NOT NULL DEFAULT 0,
                    totalClaims INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(userId)
                )`);
            } catch {}
            let rows = await db.all("SELECT * FROM daily_rewards ORDER BY streak DESC, bestStreak DESC, totalClaims DESC LIMIT 5");
            if (!rows || !rows.length) {
                await interaction.reply({ content: "No daily rewards data yet!", allowedMentions: { parse: [] } });
                return;
            }
            let embed = new EmbedBuilder()
                .setTitle("🏅 Daily Reward Leaderboard")
                .setColor(0xfacc15)
                .setDescription(
                    rows.map((r, i) =>
                        `#${i + 1}: <@${r.userId}> — Streak: **${r.streak}**, Best: **${r.bestStreak}**, Total: **${r.totalClaims}**`
                    ).join("\n")
                );
            await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
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
            await interaction.reply({content:"Could not save code.", allowedMentions: { parse: [] }});

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
        await interaction.reply({content:`🔇 User ${interaction.targetUser.tag} will not earn XP until unmuted.`, allowedMentions: { parse: [] }});

        return;
    }





    // Additional feature: context menu "Add to To-Do" on user messages
    if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === "Add To-Do") {
        let msg = interaction.targetMessage;
        await db.run("INSERT INTO todo_entries(userId, content, done, ts) VALUES (?,?,0,?)", interaction.user.id, msg.content.substring(0,300), Date.now());
        await interaction.reply({content:"Added message as a to-do in the public To-Do list. Use `/todo list` to view!", allowedMentions: { parse: [] }});

        return;
    }


    // FUN FEATURE: Thumbs up/down reaction context menu
    if (interaction.isMessageContextMenuCommand?.() && (interaction.commandName === "Thumbs Up" || interaction.commandName === "Thumbs Down")) {
        let msg = interaction.targetMessage;
        let reaction = interaction.commandName === "Thumbs Up" ? "👍" : "👎";
        // Only allow one reaction per user per message per type
        try {
            await db.run(`
                INSERT INTO reactions(messageId, userId, reaction, ts)
                VALUES (?,?,?,?)
            `, msg.id, interaction.user.id, reaction, Date.now());
        } catch(e) {
            // likely duplicate key: user already reacted, so update timestamp (allow re-action)
            await db.run(
                `UPDATE reactions SET ts=? WHERE messageId=? AND userId=? AND reaction=?`,
                Date.now(), msg.id, interaction.user.id, reaction
            );
        }
        // Count reactions
        let ups = await db.all(`SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='👍'`, msg.id);
        let downs = await db.all(`SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='👎'`, msg.id);
        // New UX: show top reactors for this message with usernames, and add a "Leaderboard" button (mentions disabled!)
        let upReactors = await db.all(
            `SELECT userId FROM reactions WHERE messageId=? AND reaction='👍' ORDER BY ts DESC LIMIT 3`,
            msg.id
        );
        let downReactors = await db.all(
            `SELECT userId FROM reactions WHERE messageId=? AND reaction='👎' ORDER BY ts DESC LIMIT 3`,
            msg.id
        );
        // Fetch user names to show instead of mentions
        let upStr = "None";
        if (upReactors.length) {
            let names = [];
            for (const u of upReactors) {
                try {
                    let user = await client.users.fetch(u.userId);
                    names.push(user.username || String(u.userId));
                } catch {
                    names.push(String(u.userId));
                }
            }
            upStr = names.join(', ');
        }
        let downStr = "None";
        if (downReactors.length) {
            let names = [];
            for (const u of downReactors) {
                try {
                    let user = await client.users.fetch(u.userId);
                    names.push(user.username || String(u.userId));
                } catch {
                    names.push(String(u.userId));
                }
            }
            downStr = names.join(', ');
        }
        // Show button to leaderboard for UX!
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('roll_leaderboard').setLabel("Dice Leaderboard").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('upvote_leaderboard').setLabel("Upvote Leaderboard").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('downvote_leaderboard').setLabel("Downvote Leaderboard").setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({
            content: `You reacted to this message with ${reaction}.\nTotal: 👍 ${ups[0].n} (recent: ${upStr}) | 👎 ${downs[0].n} (recent: ${downStr})`,
            components: [row],
            allowedMentions: { parse: [] }
        });
        // Add actual unicode reaction for quick visual feedback
        try { await msg.react(reaction); } catch {}

        // --- Additional Feature: Fun Extra: "Reaction Battle" Mini-Game ---
        // If both thumbs up/down reach threshold for a message, let the message become the "battleground" -- users can continue toggling as a game, with a button!
        // Example: If up+down >= 10
        if ((ups[0].n + downs[0].n) >= 10) {
            // Only post game button once (by checking for a previous bot reply)
            let chan = await client.channels.fetch(CHANNEL_ID);
            let recentMsgs = await chan.messages.fetch({limit: 10});
            let alreadyBattle = recentMsgs.find(m => m.author.id === client.user.id && m.content && m.content.includes(`[Reaction Battle] for message ${msg.id}`));
            if (!alreadyBattle) {
                const battleRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`reaction_battle_${msg.id}`).setLabel("Start Reaction Battle!").setStyle(ButtonStyle.Secondary)
                );
                await chan.send({
                    content: `[Reaction Battle] for message ${msg.id}: This message sparked a battle! Click to keep the tally going!`,
                    components: [battleRow],
                    allowedMentions: { parse: [] }
                });
            }
        }
        return;
    }





    // Suggestion voting feature
    if (interaction.isButton() && (/^suggest_(up|down)vote_/).test(interaction.customId)) {
        const [, type,, sugid] = interaction.customId.split("_");
        const sId = Number(sugid);
        if (!sId) return void interaction.reply({content: "Invalid suggestion ID.", allowedMentions: { parse: [] }});

        // Only allow voting once per user per suggestion
        let existing = await db.get(`SELECT * FROM reactions WHERE messageId=? AND userId=? AND reaction=?`,
            "suggestion_" + sId, interaction.user.id, `suggest:${type}`);
        if (existing) {
            await interaction.reply({content: "You already voted on this suggestion.", allowedMentions: { parse: [] }});

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
        await interaction.reply({
            content: `Thank you for your ${type === 'up' ? '👍 upvote' : '👎 downvote'}!`,
            allowedMentions: { parse: [] }
        });

        return;
    }

    // --- Additional Feature: "Reaction Battle" (toggle game for highly reacted messages) ---
    if (interaction.isButton() && interaction.customId.startsWith("reaction_battle_")) {
        let mid = interaction.customId.replace("reaction_battle_","");
        // Each click toggles between upvote and downvote for the user, and posts new totals!
        // Find last user's reaction for this message, alternate (so if thumb up, next is down, etc)
        let lastReact = await db.get(
            `SELECT reaction FROM reactions WHERE messageId=? AND userId=? ORDER BY ts DESC LIMIT 1`,
            mid, interaction.user.id
        );
        let nextReact = "👍";
        if (lastReact && lastReact.reaction === "👍") nextReact = "👎";
        // Save new reaction
        try {
            await db.run(`
                INSERT INTO reactions(messageId, userId, reaction, ts)
                VALUES (?,?,?,?)
            `, mid, interaction.user.id, nextReact, Date.now());
        } catch (e) {
            await db.run(
                `UPDATE reactions SET reaction=?, ts=? WHERE messageId=? AND userId=?`,
                nextReact, Date.now(), mid, interaction.user.id
            );
        }
        // Re-count
        let ups = await db.get(`SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='👍'`, mid);
        let downs = await db.get(`SELECT COUNT(*) as n FROM reactions WHERE messageId=? AND reaction='👎'`, mid);
        let chan = await client.channels.fetch(CHANNEL_ID);
        let content = "";
        try {
            let msg = await chan.messages.fetch(mid);
            let preview = msg.content.slice(0, 80);
            content = `**[Reaction Battle]**\n"${preview}"\n👍 **${ups.n}** | 👎 **${downs.n}**\n${ups.n>downs.n ? "👍 Team winning!" : (downs.n>ups.n ? "👎 Team winning!" : "It's a tie!")}`;
        } catch {
            content = `**[Reaction Battle]**\nMessageID: ${mid}\n👍 **${ups.n}** | 👎 **${downs.n}**`;
        }
        await interaction.reply({
            content: content,
            allowedMentions: { parse: [] }
        });
        return;
    }



    // NEW FEATURE: Upvote/Downvote Leaderboard via message context menu button
    if (interaction.isButton() && (interaction.customId === "upvote_leaderboard" || interaction.customId === "downvote_leaderboard")) {
        // Top upvotes or downvotes as public leaderboard
        let isUp = interaction.customId === "upvote_leaderboard";
        let reactionStr = isUp ? "👍" : "👎";
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
            await interaction.reply({content: `No ${isUp ? "upvoted" : "downvoted"} messages yet!`, allowedMentions: { parse: [] }});

            return;
        }

        let embed = new EmbedBuilder()
            .setTitle(isUp ? "🌟 Top Upvoted Messages" : "💢 Most Downvoted Messages")
            .setDescription(isUp ? "The most 'Thumbs Up' messages in this channel." : "Ouch! The most 'Thumbs Down' messages in this channel.");
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
        embed.setDescription(lines.join("\n") || `No ${isUp ? "upvoted" : "downvoted"} messages found.`);
        await interaction.reply({embeds:[embed], allowedMentions: { parse: [] }});
        return;
    }

    
    // --- SLASH: REPORT ---
    if (interaction.isChatInputCommand && interaction.commandName === "report") {
        // UX Restriction: Only allow in main channel, public report log, no mentions.
        if (!interaction.guild || interaction.channel.id !== CHANNEL_ID) {
            await interaction.reply({ content: "Reports must be made in the main public channel. Use the command there!", allowedMentions: { parse: [] }});
            return;
        }
        const messageId = interaction.options.getString("message_id");
        const reason = interaction.options.getString("reason");
        try {
            const chan = await client.channels.fetch(CHANNEL_ID);
            let msg;
            try {
                msg = await chan.messages.fetch(messageId);
            } catch {
                // Still allow reporting to log even if deleted
                msg = null;
            }
            // Prepare a report log entry for moderation (store in /data/reports.json), public viewing
            let reports = [];
            try { reports = await readJSONFile("reports.json", []); } catch {}
            const reportObj = {
                reporterId: interaction.user.id,
                reporterName: interaction.user.username,
                messageId: messageId,
                reportedContent: msg ? msg.content : "[Deleted/unavailable]",
                reportedAuthorId: msg ? msg.author.id : null,
                reportedAuthorName: msg ? msg.author.username : null,
                reason: reason,
                reportedAt: Date.now()
            };
            reports.push(reportObj);
            // Only keep latest 50 reports.
            if (reports.length > 50) reports = reports.slice(-50);
            await saveJSONFile("reports.json", reports);
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🚩 Message Reported")
                        .setDescription(`Message ${msg ? `from "${msg.author.username}"` : `[unavailable]`} has been reported.`)
                        .addFields(
                            { name: "Reason", value: reason },
                            { name: "Message ID", value: messageId },
                            { name: "Reporter", value: interaction.user.username }
                        )
                        .setFooter({ text: "All reports are public and logged in /reports" })
                        .setColor(0xff3b3b)
                        .setTimestamp()
                ],
                allowedMentions: { parse: [] }
            });
        } catch (e) {
            await interaction.reply({ content: "Failed to report the message. Make sure the ID is correct!", allowedMentions: { parse: [] } });
        }
        return;
    }

// === [ FEATURE: REPORT DELETE BUTTON HANDLER & WARNING DELETE BUTTON HANDLER ] ===
client.on('interactionCreate', async interaction => {
    // --- Report delete via number index or messageId ---
    if (interaction.isButton() && (
        interaction.customId.startsWith('delete_report_') ||
        interaction.customId.startsWith('delete_report_num_')
    )) {
        let reports = [];
        try { reports = await readJSONFile("reports.json", []); } catch {}
        let idx = -1;
        if (interaction.customId.startsWith('delete_report_num_')) {
            // Button: delete by display index (as seen in UI): count back from end
            let displayIdx = parseInt(interaction.customId.slice('delete_report_num_'.length), 10); // 1-based idx
            if (isNaN(displayIdx) || displayIdx < 1) {
                await interaction.reply({ content: "Invalid report number!", allowedMentions: { parse: [] }});
                return;
            }
            // Slice last 10, then find corresponding index in reports (since reversed)
            const last10 = reports.slice(-10);
            idx = reports.length - last10.length + (last10.length - displayIdx);
            if (idx < 0 || idx >= reports.length) {
                await interaction.reply({ content: "Report number not found.", allowedMentions: { parse: [] }});
                return;
            }
        } else if (interaction.customId.startsWith('delete_report_')) {
            // legacy: delete by messageId (last occurrence)
            let msgId = interaction.customId.slice('delete_report_'.length);
            for (let i = reports.length-1; i >= 0; --i) {
                if (reports[i].messageId === msgId) {
                    idx = i; break;
                }
            }
            if (idx === -1) {
                await interaction.reply({ content: "No such report found to delete.", allowedMentions: { parse: [] } });
                return;
            }
        }
        reports.splice(idx,1);
        await saveJSONFile("reports.json", reports);
        await interaction.reply({ content: "Report has been deleted.", allowedMentions: { parse: [] } });
        return;
    }

    // --- Warning delete via button ---
    if (interaction.isButton() && interaction.customId.startsWith('delete_warning_')) {
        let wid = interaction.customId.slice('delete_warning_'.length);
        if (!wid) {
            await interaction.reply({ content: "Invalid warning ID.", allowedMentions: { parse: [] } });
            return;
        }
        try {
            // Delete directly from warnings table
            await db.run('DELETE FROM warnings WHERE id=?', wid);
            await interaction.reply({ content: "Warning has been deleted.", allowedMentions: { parse: [] } });
        } catch {
            await interaction.reply({ content: "Failed to delete warning.", allowedMentions: { parse: [] } });
        }
        return;
    }
});


// --- SLASH: REPORTS (view all public reports) ---
    if (interaction.isChatInputCommand && interaction.commandName === "reports") {
        // Anyone can view recent public reports; add delete button per report (up to 5 for moderation transparency)
        let reports = [];
        try { reports = await readJSONFile("reports.json", []); } catch {}
        if (!reports.length) {
            await interaction.reply({ content: "No message reports yet!", allowedMentions: { parse: [] } });
            return;
        }
        // List last 10, newest first; allow delete by # via buttons for up to 5
        const repRows = reports.slice(-10).reverse().map((r,i)=>({...r, displayIndex: i+1 }));
        const embed = new EmbedBuilder()
            .setTitle("🚩 Recent Message Reports")
            .setDescription(repRows.map(r =>
                `**[${r.displayIndex}]** Reporter: ${r.reporterName}\nMessage ID: ${r.messageId}` +
                (r.reportedAuthorName ? `\nAuthor: ${r.reportedAuthorName}` : "") +
                `\nContent: ${r.reportedContent.slice(0,80)}\nReason: ${r.reason}\nAt: <t:${Math.floor(r.reportedAt/1000)}:f>`
            ).join('\n\n'))
            .setColor(0xffbdbd)
            .setFooter({ text: "Reports are public, for transparency." });
        const actionRow = new ActionRowBuilder().addComponents(
            repRows.slice(0,5).map(r =>
                new ButtonBuilder().setCustomId('delete_report_num_' + r.displayIndex).setLabel(`Delete #${r.displayIndex}`).setStyle(ButtonStyle.Danger)
            )
        );
        await interaction.reply({ embeds: [embed], components: repRows.length ? [actionRow] : [], allowedMentions: { parse: [] } });
        return;
    }




// --- ADD: MODERATION FEATURE - /warns (Public warning history summary) ---
    if (interaction.isChatInputCommand && interaction.commandName === "warns") {
        // Show all warnings in the server (last 10, public, usernames only) + allow delete by number (admin/all)
        let warnings = [];
        try { warnings = await db.all('SELECT id, userId, reason, timestamp FROM warnings ORDER BY timestamp DESC LIMIT 10'); } catch {}
        if (!warnings.length) {
            await interaction.reply({ content: "No warnings issued yet!", allowedMentions: { parse: [] } });
            return;
        }
        const userNameMap = {};
        for (const w of warnings) {
            try {
                let u = await client.users.fetch(w.userId);
                userNameMap[w.userId] = u.username;
            } catch {
                userNameMap[w.userId] = w.userId;
            }
        }
        const warnRows = warnings.map((w, i)=> ({
            ...w,
            displayIndex: i+1
        }));
        let embed = new EmbedBuilder()
            .setTitle("⚠️ Recent User Warnings")
            .setDescription(warnRows.map((w) =>
                `**[${w.displayIndex}]** User: ${userNameMap[w.userId]}\nReason: ${w.reason}\nAt: <t:${Math.floor(w.timestamp/1000)}:f>`
            ).join("\n\n"))
            .setColor(0xffc34d)
            .setFooter({ text: "All warnings are public for transparency." });
        const actionRow = new ActionRowBuilder().addComponents(
            warnRows.map(w =>
                new ButtonBuilder()
                    .setCustomId(`delete_warning_${w.id}`)
                    .setLabel(`Delete #${w.displayIndex}`)
                    .setStyle(ButtonStyle.Danger)
            ).slice(0,5)
        );
        await interaction.reply({
            embeds: [embed],
            components: warnRows.length ? [actionRow] : [],
            allowedMentions: { parse: [] }
        });
        return;
    }

    // --- ADDITIONAL FEATURE: CLEARMESSAGES (MODERATION TOOL) ---
    if (interaction.isChatInputCommand && interaction.commandName === "clearmessages") {
        // Admin tool: delete all messages from a specific user in the main channel, log to audit trail
        const targetUser = interaction.options.getUser("target_user");
        if (!targetUser) {
            await interaction.reply({ content: "You must select a user.", allowedMentions: { parse: [] } });
            return;
        }
        try {
            const chan = await client.channels.fetch(CHANNEL_ID);
            let messages = await chan.messages.fetch({ limit: 100 });
            let toDelete = messages.filter(m => m.author.id === targetUser.id && !m.author.bot);
            let delCount = 0;
            for (let m of toDelete.values()) {
                try {
                    await m.delete();
                    // Also log as deleted in message_logs for transparency/mod log
                    await db.run("UPDATE message_logs SET deleted=1 WHERE messageId=?", m.id);
                    delCount++;
                } catch {}
            }
            await interaction.reply({
                content: `🧹 Attempted to delete ${delCount} messages from user ${targetUser.username} in this channel (check audit logs for details).`,
                allowedMentions: { parse: [] }
            });
            // Optionally record audit event in /data/mod_audit.log
            try {
                let log = [];
                try { log = await readJSONFile("mod_audit.json", []); } catch {}
                log.push({
                    action: "clearmessages",
                    admin: interaction.user.username,
                    targetUser: targetUser.username,
                    count: delCount,
                    at: Date.now()
                });
                if (log.length > 200) log = log.slice(-200);
                await saveJSONFile("mod_audit.json", log);
            } catch {}
        } catch {
            await interaction.reply({ content: "Failed to delete messages for that user. Check ID and permissions, and try again.", allowedMentions: { parse: [] } });
        }
        return;
    }

});



/**
 * Migration: add "handled" column to suggestion if missing (for deployments with pre-existing data)
 */
try {
    const cols = await db.all("PRAGMA table_info('suggestion')");
    if (!cols.some(c => c.name === "handled")) {
        await db.run("ALTER TABLE suggestion ADD COLUMN handled INTEGER NOT NULL DEFAULT 0");
    }
} catch {}


 // --- Startup reminder boot ---
// Show top 5 most upvoted messages feature
// On ready, post a welcome embed + button in the configured main channel (only if not already posted recently)
// UX improvement: On startup, always (re)show the onboarding "Get Started" message in CHANNEL_ID
client.once('ready', async () => {

    console.log(`Ready as ${client.user.tag}`);
    scheduleReminders(client);

    // ------ [NEW FEATURE] Close expired polls after client ready ------
    try {
        let leftOpenPolls = await db.all(`SELECT * FROM poll WHERE expiresAt IS NOT NULL AND expiresAt < ?`, Date.now());
        for (const pollRec of leftOpenPolls) {
            try {
                const chan = await client.channels.fetch(pollRec.channelId);
                await finishPoll(pollRec, chan);
            } catch {}
        }
    } catch {}
    // ---------------------------------------------------------------

    // Custom status
    client.user.setActivity({
        type: 3, // "Watching"
        name: "slash commands! (/help)"
    });

    try {
        const chan = await client.channels.fetch(CHANNEL_ID);
        // Try to find last 'Get Started' welcome message in the last 10 by this bot; if not present or >24h old, send again.
        let msgs = await chan.messages.fetch({ limit: 10 });
        let already = msgs.find(m=>
            m.author.id === client.user.id &&
            m.embeds?.[0]?.title === "Getting Started with this Bot"
        );
        // If not found or old, post anew.
        if (!already || (Date.now() - (already.createdTimestamp||0) > 24*3600*1000)) {
            await chan.send({
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
                ],
                components: [
                    welcomeButtonRow
                ]
            });
        }
    } catch { }

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

// [Additional Feature: Reminders View Button]
client.on('interactionCreate', async interaction => {
    // Button handler for viewing reminders in public (UX improv)
    if (interaction.isButton() && interaction.customId === 'reminders_view_btn') {
        // List the user's reminders in the main channel (public context)
        let rows = await db.all('SELECT content, remindAt FROM reminders WHERE userId=? ORDER BY remindAt ASC', interaction.user.id);
        if (!rows.length) {
            await interaction.reply({ content: "You have no pending reminders!", allowedMentions: { parse: [] } });
        } else {
            let embed = new EmbedBuilder()
                .setTitle(`⏰ Your Pending Reminders`)
                .setDescription(
                    rows.map((r, i) => `**[${i+1}]** ${r.content} (in <t:${Math.floor(r.remindAt/1000)}:R>)`).join('\n')
                )
                .setColor(0xc084fc);
            await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }
        return;
    }

    // [NEW FEATURE] Recurring reminders (set daily)
    if (interaction.isButton() && interaction.customId.startsWith("recurreminder_")) {
        // Extract content from customId
        let baseContent = interaction.customId.replace("recurreminder_","");
        // Try to find a reminder of this content recently set by this user
        let allRows = await db.all('SELECT id, content, remindAt FROM reminders WHERE userId=? ORDER BY remindAt DESC LIMIT 10', interaction.user.id);
        let found = allRows.find(row => row.content && row.content.replace(/\W/g,"").slice(0,20) === baseContent);
        if (!found) {
            await interaction.reply({ content: "Could not set recurring reminder (was your reminder recent?)", allowedMentions: { parse: [] } });
            return;
        }
        // Save to /data/recurring_reminders.json as a simple array
        let recurs = [];
        try { recurs = await readJSONFile("recurring_reminders.json", []); } catch {}
        // Don't duplicate
        if (recurs.find(r => r.userId===interaction.user.id && r.content===found.content && r.intervalMs===24*60*60*1000)) {
            await interaction.reply({ content: "You already have this as a recurring reminder!", allowedMentions: { parse: [] } });
            return;
        }
        recurs.push({
            userId: interaction.user.id,
            content: found.content,
            nextAt: found.remindAt,
            baseTime: found.remindAt,
            intervalMs: 24*60*60*1000,
            created: Date.now()
        });
        await saveJSONFile("recurring_reminders.json", recurs);
        await interaction.reply({content: "✅ Set up as a daily recurring reminder! I will post it every day at this time.", allowedMentions: { parse: [] }});
        // Optionally: update UI or send further info
        return;
    }

    // FIX: Guard .member on permission checks for admin DM/system
    if (
        typeof interaction.isChatInputCommand === "function" &&
        interaction.isChatInputCommand() &&
        interaction.commandName === 'settings' &&
        interaction.options?.getBoolean("autodelete")===false
    ) {
        // Permissions not required - all users are 'admin' for demonstration
        await fs.writeFile(DATA_DIR + "autodelete_botreplies.txt", "off");
        await interaction.reply({content:"Bot reply auto-delete turned OFF.", allowedMentions: { parse: [] }});

        return;
    } else if (
        typeof interaction.isChatInputCommand === "function" &&
        interaction.isChatInputCommand() &&
        interaction.commandName === 'settings' &&
        interaction.options?.getBoolean("autodelete")===true
    ) {
        // Permissions not required - all users are 'admin' for demonstration
        await fs.writeFile(DATA_DIR + "autodelete_botreplies.txt", "on");
        await interaction.reply({content:"Bot reply auto-delete ON (where possible).", allowedMentions: { parse: [] }});

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
        await interaction.reply({content:"Added to content blocklist.", allowedMentions: { parse: [] }});

        return;
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
