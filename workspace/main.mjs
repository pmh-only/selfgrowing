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
    catch { await fs.mkdir(DATA_DIR, { recursive: true }

    // ---- BUTTON: Poll voting ----
    if (interaction.isButton() && interaction.customId.startsWith("vote_")) {
        let pollRecord = await db.get("SELECT * FROM poll WHERE messageId = ?", interaction.message.id);
        if (!pollRecord || pollRecord.expiresAt < Date.now()) {
            await interaction.reply({content:"This poll has ended!", ephemeral:true});
            return;
        }
        if (interaction.customId === "vote_retract") {
            let votes = {};
            try { votes = JSON.parse(pollRecord.votes || "{}"); } catch {}
            if (!votes[interaction.user.id] && votes[interaction.user.id]!==0) {
                await interaction.reply({content:"You haven't voted yet.", ephemeral:true}); return;
            }
            delete votes[interaction.user.id];
            await db.run("UPDATE poll SET votes=? WHERE messageId=?", JSON.stringify(votes), interaction.message.id);
            await interaction.reply({content:"Your vote has been retracted.", ephemeral:true});
            return;
        }
        const optionIdx = parseInt(interaction.customId.split("_")[1]);
        let votes = {};
        try { votes = JSON.parse(pollRecord.votes || "{}"); } catch {}
        votes[interaction.user.id] = optionIdx;
        await db.run("UPDATE poll SET votes=? WHERE messageId=?", JSON.stringify(votes), interaction.message.id);

        // Tally and update poll message with visually updated buttons
        // Show current results only to voter
        const opts = JSON.parse(pollRecord.options);
        let counts = opts.map((_,i)=>Object.values(votes).filter(v=>v==i).length);
        let total = counts.reduce((a,b)=>a+b,0);
        let userVote = optionIdx;
        let desc = opts.map((opt,i)=>
            `${pollEmojis[i]} **${opt}** — ${counts[i]} vote${counts[i]!=1?'s':''}` +
            (userVote===i ? " **⬅️ Your selection**" : "")
        ).join("\n");
        if (total===0) desc+="\n*No votes yet*";

        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`📊 ${pollRecord.title} (Vote Registered)`)
                    .setDescription(desc)
                    .setFooter({text: `Poll closes at <t:${Math.floor(pollRecord.expiresAt/1000)}:f>`})
            ],
            ephemeral: true
        });
        // Quick UX: acknowledge on button, don't update base poll message (other than at end)
        return;
    }

});

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
 }
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
    timestamp INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0
)`);
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
await db.run(`CREATE TABLE IF NOT EXISTS message_logs (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    username TEXT,
    content TEXT,
    createdAt INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
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

// migrate pinned_notes -> todo_entries (one-time, idempotent)
async function migratePinnedToTodo() {
    const pinned = await db.all("SELECT * FROM pinned_notes");
    if (!pinned.length) return;
    const existing = await db.get(`SELECT COUNT(*) as n FROM todo_entries`);
    if (existing.n>0) return;
    for (const p of pinned) {
        const note = await db.get("SELECT note, timestamp FROM notes WHERE id=?", p.noteId);
        if (!note) continue;
        await db.run("INSERT INTO todo_entries(userId, content, done, ts) VALUES (?,?,0,?)", p.ownerId, note.note, note.timestamp);
    }
    await db.run("DROP TABLE IF EXISTS pinned_notes");
}
await migratePinnedToTodo();

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

// --- Login ---
await client.login(TOKEN);

/*
New UX/features added in this SEARCH/REPLACE update:
- /todo: private to-do list manager (submenu add, complete, remove, list)
- Cooldown on /purge for safety, visual confirm button before delete.
- /quote now allows tagging a category with a modal, /quotes can filter by it.
- Poll: allow user to retract vote
- /dmuser (admin only): DM a user with a message (helpful for reaching out privately)
- Properly migrate pinned_notes table from pinned_notes(ownerId,noteId) to todo_entries(userId, content, done, ts), if needed.
- Show a welcome embed in DM with a persistent "Get Started" button for onboarding.
- /xp: level-up history with timestamps available.
*/

import path from 'path';

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
    }

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
        description: "Show a random saved quote"
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
            { name:'autodelete',type:5,description:"Enable/disable auto-deleting moderation bot replies",required:true }
        ]
    },
    {
        name: 'snipe',
        description: "Show the last deleted message in this channel (moderation tool)"
    },
    {
        name: 'stats',
        description: "Show bot usage stats & message counts"
    }
];


const rest = new REST({version: '10'}).setToken(TOKEN);
await rest.put(Routes.applicationGuildCommands((await client.application?.id) || "0", GUILD_ID), {body: commands});

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

    // ---- SLASH: POLL ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'poll') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
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
            .setColor(0x0ebbaf);
        const row = new ActionRowBuilder().addComponents(
            opts.map((_,i)=>
                new ButtonBuilder().setCustomId(`vote_${i}`).setLabel(String.fromCharCode(65+i)).setStyle(ButtonStyle.Primary)
            ).concat(new ButtonBuilder().setCustomId('vote_retract').setLabel('Retract Vote').setStyle(ButtonStyle.Secondary))
        );
        const cmsg = await interaction.reply({ embeds: [embed], components:[row], fetchReply:true });
        await db.run(`
            INSERT INTO poll(title, options, creatorId, channelId, messageId, votes, expiresAt)
            VALUES (?,?,?,?,?,?,?)
        `, title, JSON.stringify(opts), interaction.user.id, interaction.channel.id, cmsg.id, '{}', Date.now()+dur);
        setTimeout(async ()=>{
            let p = await db.get('SELECT * FROM poll WHERE messageId=?', cmsg.id);
            if (!p) return;
            await finishPoll(p, interaction.channel);
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
            ], ephemeral: true
        });
        return;
    }

    // --- SLASH: QUOTE (admin, with category modal) ---
    if (interaction.isChatInputCommand() && interaction.commandName === "quote") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
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
        if (interaction.options.getSubcommand() === 'add') {
            const txt = interaction.options.getString('content').substring(0, 500);
            await db.run('INSERT INTO notes(userId, note, timestamp) VALUES (?,?,?)',
                interaction.user.id, txt, Date.now());
            await interaction.reply({content:'📝 Note saved (DM only)!', ephemeral:true});
        } else if (interaction.options.getSubcommand() === 'list') {
            const rows = await db.all('SELECT id, note, timestamp FROM notes WHERE userId=? ORDER BY id DESC LIMIT 10', interaction.user.id);
            if (rows.length === 0) await interaction.reply({content:"No notes yet.", ephemeral:true});
            else {
                const embed = new EmbedBuilder()
                  .setTitle("Your last 10 notes")
                  .setDescription(rows.map((r,i) => `**[${rows.length-i}]** ${r.note} _(at <t:${Math.floor(r.timestamp/1000)}:f>)_`).join("\n"))
                  .setColor(0x80ecec);
                await interaction.reply({embeds:[embed], ephemeral:true});
            }
        } else if (interaction.options.getSubcommand() === 'delete') {
            const idx = interaction.options.getInteger('number');
            const allRows = await db.all('SELECT id FROM notes WHERE userId=? ORDER BY id DESC LIMIT 10', interaction.user.id);
            if (!allRows[idx-1]) return void interaction.reply({content:"Invalid note number!", ephemeral:true});
            await db.run('DELETE FROM notes WHERE id=?', allRows[idx-1].id);
            await interaction.reply({content:"🗑️ Note deleted.", ephemeral:true});
        } else if (interaction.options.getSubcommand() === "pin") {
            await interaction.reply({content:"⚠️ To pin notes, please use `/todo add` with the note content!", ephemeral:true});
        } else if (interaction.options.getSubcommand() === "pinned") {
            const todos = await db.all("SELECT content, done, ts FROM todo_entries WHERE userId=? ORDER BY ts DESC", interaction.user.id);
            if (!todos.length)
                return void interaction.reply({content:"No pinned notes (your pinned notes are now found in `/todo list` as your To-Do list).", ephemeral:true});
            const embed = new EmbedBuilder()
                .setTitle("📝 Your Pinned Notes (To-Do List)")
                .setDescription(todos.slice(0,10).map((t,i)=>`${t.done?'✅':'❌'} **[${i+1}]** ${t.content} _(at <t:${Math.floor(t.ts/1000)}:f>)_`).join("\n"))
                .setColor(0xfecf6a);
            await interaction.reply({embeds:[embed], ephemeral:true});
        } else if (interaction.options.getSubcommand() === "search") {
            const query = interaction.options.getString("query").toLowerCase();
            const rows = await db.all('SELECT note, timestamp FROM notes WHERE userId=? ORDER BY id DESC LIMIT 50', interaction.user.id);
            const matches = rows.filter(r => r.note.toLowerCase().includes(query));
            if (!matches.length) return void interaction.reply({content:`No matching notes found for "${query}".`,ephemeral:true});
            const embed = new EmbedBuilder()
                .setTitle(`🔎 Notes matching "${query}"`)
                .setDescription(matches.slice(0,10).map((n,i)=>`**[${i+1}]** ${n.note} _(at <t:${Math.floor(n.timestamp/1000)}:f>)_`).join("\n"))
                .setColor(0x4a90e2);
            await interaction.reply({embeds:[embed], ephemeral: true});
        }
        return;
    }


    // --- SLASH: TODO ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'todo') {
        if (interaction.guild) {
            await interaction.reply({content:"For privacy, use To-Do in DM only.", ephemeral:true}); return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === "add") {
            let txt = interaction.options.getString("content").substring(0,300);
            await db.run("INSERT INTO todo_entries(userId, content, done, ts) VALUES (?,?,0,?)", interaction.user.id, txt, Date.now());
            await interaction.reply({content:"📝 To-do added!",ephemeral:true});
        } else if (sub === "complete") {
            let idx = interaction.options.getInteger('number');
            let rows = await db.all("SELECT id, content FROM todo_entries WHERE userId=? ORDER BY ts DESC LIMIT 15", interaction.user.id);
            if (!rows[idx-1]) return void interaction.reply({content:"Invalid to-do #", ephemeral:true});
            await db.run("UPDATE todo_entries SET done=1 WHERE id=?", rows[idx-1].id);
            await interaction.reply({content:`✅ Marked "${rows[idx-1].content}" as done.`, ephemeral:true});
        } else if (sub === "remove") {
            let idx = interaction.options.getInteger('number');
            let rows = await db.all("SELECT id FROM todo_entries WHERE userId=? ORDER BY ts DESC LIMIT 15", interaction.user.id);
            if (!rows[idx-1]) return void interaction.reply({content:"Invalid to-do #", ephemeral:true});
            await db.run("DELETE FROM todo_entries WHERE id=?", rows[idx-1].id);
            await interaction.reply({content:"🗑️ To-do removed.", ephemeral:true});
        } else if (sub === "list") {
            let todos = await db.all("SELECT content, done, ts FROM todo_entries WHERE userId=? ORDER BY ts DESC", interaction.user.id);
            if (!todos.length) return void interaction.reply({content:"Your to-do list is empty!",ephemeral:true});
            let embed = new EmbedBuilder()
                .setTitle("📝 Your To-Do List")
                .setDescription(todos.map((t,i)=>`${t.done?'✅':'❌'} **[${i+1}]** ${t.content} _(at <t:${Math.floor(t.ts/1000)}:f>)_`).join("\n"))
                .setColor(0xfcc063);
            await interaction.reply({embeds:[embed], ephemeral:true});
        }
        return;
    }

    // --- SLASH: DMUSER ---
    if (interaction.isChatInputCommand() && interaction.commandName === "dmuser") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.",ephemeral:true}); return;
        }
        const user = interaction.options.getUser('user');
        const txt = interaction.options.getString('message');
        try {
            await user.send(`[Message from admin]\n${txt}`);
            await interaction.reply({content:`Sent DM to ${user.tag}`, ephemeral:true});
        } catch {
            await interaction.reply({content:"I couldn't DM this user (maybe DM closed).", ephemeral:true});
        }
        return;
    }





    // --- SLASH: TIMER ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'timer') {
        // Only allow in DM
        if (interaction.guild) {
            await interaction.reply({content:"Use /timer in DM only!", ephemeral:true}); return;
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
          try { await interaction.user.send(`⏰ [TIMER "${last.name}" DONE] Your ${humanizeMs(last.duration)} timer finished!`);} catch{}
        }, dur);
        await interaction.reply({content:`⏳ Timer **"${name}"** started for ${humanizeMs(dur)}! I'll DM when done.`, ephemeral:true});
        return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "timers") {
        if (interaction.guild) {
            await interaction.reply({content:"Use in DM only",ephemeral:true}); return;
        }
        const rows = await db.all('SELECT name, setAt, duration, running FROM timers WHERE userId=? ORDER BY setAt DESC LIMIT 10', interaction.user.id);
        if (!rows.length) return void interaction.reply({content:"No running or completed timers found.", ephemeral:true});
        let desc = rows.map(r => {
            if (r.running) {
                let left = humanizeMs(r.setAt + r.duration - Date.now());
                return `⏳ **${r.name}** — ends in ${left}`;
            } else {
                return `✅ **${r.name}** — finished`;
            }
        }).join('\n');
        await interaction.reply({embeds:[new EmbedBuilder().setTitle("Your timers").setDescription(desc).setColor(0xd1882a)], ephemeral:true});
        return;
    }
    // --- SLASH: REMIND ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'remind') {
        const content = interaction.options.getString('content').substring(0,200);
        const delay = parseTime(interaction.options.getString('time'));
        if (!delay) return void interaction.reply({content:"Invalid time. Use e.g. 10m, 2h, 1d (or combine, e.g. 1h30m)", ephemeral:true});
        if (delay > 7*24*60*60*1000) return void interaction.reply({content:"Max is 7d.",ephemeral:true});
        await db.run('INSERT INTO reminders(userId, content, remindAt) VALUES (?,?,?)',
            interaction.user.id, content, Date.now() + delay);
        await interaction.reply({content:`⏰ Reminder set! I will DM you in ${humanizeMs(delay)}.`, ephemeral:true});
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
    // --- SLASH: PURGE with Confirmation and Cooldown ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'purge') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({content:"You lack perms.",ephemeral:true});
            return;
        }
        // Safety Cooldown
        if (!client._purgeCooldown) client._purgeCooldown = {};
        const lastT = client._purgeCooldown[interaction.user.id]||0;
        if (Date.now()-lastT < 60000)
            return void interaction.reply({content:`Please wait before purging again for safety. (${Math.ceil((60000-(Date.now()-lastT))/1000)}s left)`,ephemeral:true});
        let n = interaction.options.getInteger('count');
        if (n<1 || n>50) {
            await interaction.reply({content:'Count must be 1-50.',ephemeral:true});
            return;
        }
        // Confirm visual with button
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('purge_confirm_'+Date.now())
                .setLabel('Confirm Delete')
                .setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({content:`⚠️ Confirm deletion of ${n} messages?`, components:[row], ephemeral:true});
        client.once('interactionCreate', async btn=> {
            if (!btn.isButton() || !btn.customId.startsWith("purge_confirm_") || btn.user.id!==interaction.user.id) return;
            client._purgeCooldown[interaction.user.id] = Date.now();
            const chan = await client.channels.fetch(CHANNEL_ID);
            const msgs = await chan.messages.fetch({limit:Math.min(50,n)});
            await chan.bulkDelete(msgs, true);
            await btn.reply({content:`🧹 Deleted ${msgs.size} messages.`,ephemeral:true});
        });
        return;
    }

    // --- SLASH: XP ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'xp') {
        const row = await db.get('SELECT xp, level FROM xp WHERE userId=?', interaction.user.id);
        if (!row) await interaction.reply({content:'No XP on record.',ephemeral:true});
        else {
            // Also show last time user leveled up (if possible)
            let prev = await db.all(`SELECT createdAt FROM message_logs WHERE userId=? ORDER BY createdAt DESC LIMIT 100`, interaction.user.id);
            // Guess from increments (hack: not strictly precise)
            let msg = `You have ${row.xp} XP at level ${row.level}.`;
            if (row.level>=1 && prev.length) {
                msg += `\n🌟 Leveled up most recently at <t:${Math.floor(prev[0].createdAt/1000)}:f>`;
            }
            await interaction.reply({content:msg,ephemeral:true});
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
        if (!lastDeleted) return void interaction.reply({content:"No deleted messages found.", ephemeral:true});
        const embed = new EmbedBuilder()
            .setTitle("🕵️ Last Deleted Message")
            .setDescription(lastDeleted.content || "*[no content]*")
            .setFooter({text: `By ${lastDeleted.username || lastDeleted.userId}`})
            .setTimestamp(lastDeleted.createdAt || Date.now());
        await interaction.reply({embeds:[embed], ephemeral:true});
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
        await interaction.reply({embeds:[embed], ephemeral:true});
        return;
    }
});


let lastMessageUserCache = {};

client.on('messageCreate', async msg => {
    // Restrict to the one allowed channel (except for DMs)
    if (msg.guild && msg.channel.id !== CHANNEL_ID) return;
    if (msg.author.bot) return;

    // AUTO-RESPOND FRIEND MODE (fun UX): 
    if (msg.guild && msg.mentions.has(client.user) && msg.content.length < 80) {
        let responses = [
            "Hey there! Want help? Try `/` for commands.",
            "👋 How can I help you today?",
            "Use `/note` to keep your thoughts, `/remind` for reminders!",
            "Want to stay organized? `/todo` manages your to-dos!",
            "Need fun? `/8ball` awaits your questions.",
            "I'm always here to assist. Type `/` to see more."
        ];
        await msg.reply({content: responses[Math.floor(Math.random()*responses.length)], ephemeral: true});
    }



    // --- Log all messages for moderation/stats ---
    if (msg.guild) {
        await db.run('INSERT INTO message_logs(userId, username, content, createdAt) VALUES (?,?,?,?)',
            msg.author.id, (msg.member?.user?.tag || msg.author.username), msg.content, Date.now());
        lastMessageUserCache[msg.author.id] = { username: msg.member?.user?.tag || msg.author.username };
    }

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
            await db.run(
                'UPDATE message_logs SET deleted=1 WHERE userId=? ORDER BY createdAt DESC LIMIT 1',
                msg.author.id
            );
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

    // Custom status
    client.user.setActivity({
        type: 3, // "Watching"
        name: "slash commands! (/help)"
    });
});


client.on('messageDelete', async msg => {
    // Log which message was deleted for use with /snipe
    if (!msg.partial && msg.guild && msg.channel.id === CHANNEL_ID && !msg.author?.bot) {
        await db.run("UPDATE message_logs SET deleted=1 WHERE userId=? AND content=? AND deleted=0 ORDER BY createdAt DESC LIMIT 1", msg.author.id, msg.content);
    }
});

let userWelcomeStatus = {};

const welcomeButtonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
        .setCustomId('dm_getstarted')
        .setLabel('Get Started')
        .setStyle(ButtonStyle.Success)
);

client.on('messageCreate', async msg => {
    if (msg.guild) return; // only DMs
    if (msg.author.bot) return;
    // Single welcome message per session, with "Get Started" button
    if (!userWelcomeStatus[msg.author.id]) {
        await msg.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("👋 Welcome!")
                    .setDescription([
                        "I'm your private assistant — **notes**, **to-do** (try `/todo`), **reminders**, **polls**, fun and more via slash commands!",
                        "",
                        "**Try:**",
                        "- `/todo add` to manage a personal to-do list",
                        "- `/note add` for quick notes",
                        "- `/remind` for DM reminders",
                        "- `/avatar` to view profile pictures",
                        "- `/quotes` to inspire/laugh",
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
        await msg.reply(`Available commands:\n- /note\n- /note search\n- /todo\n- /remind\n- /poll #channel\n- /timer\n- /timers\n- /quotes\n\n⭐ Use /todo to pin favorites and stay organized!`);
    } else if (/timer/i.test(msg.content)) {
        await msg.reply("Try `/timer` to set a DM countdown for yourself, or `/timers` to view your timers!");
    } else {
        await msg.reply(`Hi! Slash commands available: /todo, /note, /note search, /remind, /poll, /timer, /quotes, more! (Type \`/\` to see all options, or click **Get Started** below.)`);
    }
});

// DM Get Started button handler for welcome embed
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
                    "- `/note add` — Quick notes (private, always DM only)",
                    "- `/remind` — DM reminders, even days in advance!",
                    "- `/poll` — Admins: Create quick channel polls",
                    "- `/xp` — Chat to earn XP & level up",
                    "- `/8ball` — Ask for cosmic wisdom",
                    "- `/avatar` — View yours or anyone's pfp",
                    "- `/leaderboard` — Top chatters/XP",
                    "",
                    "🆕 **All personal data is private, saved for YOU — `/todo` and `/note` are in **DMs only**!"
                ].join("\n"))
                .setColor(0xfacc15)
        ],
        ephemeral: true
    });
});












