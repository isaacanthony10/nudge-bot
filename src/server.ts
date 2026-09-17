import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import dotenv from 'dotenv';
import * as chrono from 'chrono-node';

dotenv.config();

export interface Task {
  id: number;
  text: string;
  dueDate?: string; // Format: YYYY-MM-DD HH:mm
  reminded?: boolean;
  recurring?: 'daily' | 'weekly' | 'monthly' | null;
}

const TASKS_FILE = path.join(__dirname, '..', 'tasks.json');
const LAST_ACTIVE_FILE = path.join(__dirname, '..', 'last_active.json');

// --- Per-User Persistence ---
function loadTasks(): Record<string, Task[]> {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
    }
  } catch (error) {
    console.error('Error loading tasks:', error);
  }
  return {};
}

function saveTasks(tasks: Record<string, Task[]>) {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving tasks:', error);
  }
}

function loadLastActive(): Record<string, number> {
  try {
    if (fs.existsSync(LAST_ACTIVE_FILE)) {
      return JSON.parse(fs.readFileSync(LAST_ACTIVE_FILE, 'utf-8'));
    }
  } catch (error) {
    console.error('Error loading last active timestamps:', error);
  }
  return {};
}

function saveLastActive(data: Record<string, number>) {
  try {
    fs.writeFileSync(LAST_ACTIVE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving last active timestamps:', error);
  }
}

const tasksDB: Record<string, Task[]> = loadTasks();
const lastActiveDB: Record<string, number> = loadLastActive();

// --- Helper Functions for Dates ---
function formatDate(d: Date): string {
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}`;
}

function computeNextRecurrence(currentDueDateStr: string, recurrence: 'daily' | 'weekly' | 'monthly'): string {
  const dateObj = new Date(currentDueDateStr.replace(' ', 'T'));
  if (recurrence === 'daily') {
    dateObj.setDate(dateObj.getDate() + 1);
  } else if (recurrence === 'weekly') {
    dateObj.setDate(dateObj.getDate() + 7);
  } else if (recurrence === 'monthly') {
    dateObj.setMonth(dateObj.getMonth() + 1);
  }
  return formatDate(dateObj);
}

// --- Conversational & Natural Language Task Parser ---
function parseIncomingMessage(userPrompt: string): {
  isTask: boolean;
  taskText?: string;
  dueDate?: string;
  recurring?: 'daily' | 'weekly' | 'monthly' | null;
} {
  let trimPrompt = userPrompt.trim();

  // Clean conversational prefixes like "Hey Nudge," "Nudge,", "Hi Nudge,"
  trimPrompt = trimPrompt.replace(/^(hey|hi|hello|yo)?\s*nudge[,:]?\s*/i, '').trim();

  const lowerPrompt = trimPrompt.toLowerCase();

  const triggers = [
    'remind me for ',
    'remind me about ',
    'remind me to ',
    'remind me ',
    'remind ',
    'i need to ',
    'i have to ',
    'add task ',
    'add ',
    'todo '
  ];

  const matchedTrigger = triggers.find(t => lowerPrompt.startsWith(t));

  if (!matchedTrigger) {
    return { isTask: false };
  }

  let taskText = trimPrompt.slice(matchedTrigger.length).trim();
  let recurring: 'daily' | 'weekly' | 'monthly' | null = null;

  if (/\bevery day\b|\bdaily\b/i.test(taskText)) {
    recurring = 'daily';
    taskText = taskText.replace(/\bevery day\b|\bdaily\b/gi, '').trim();
  } else if (/\bevery week\b|\bweekly\b|\bevery monday\b|\bevery tuesday\b|\bevery wednesday\b|\bevery thursday\b|\bevery friday\b|\bevery saturday\b|\bevery sunday\b/i.test(taskText)) {
    recurring = 'weekly';
    taskText = taskText.replace(/\bevery week\b|\bweekly\b/gi, '').trim();
  } else if (/\bevery month\b|\bmonthly\b/i.test(taskText)) {
    recurring = 'monthly';
    taskText = taskText.replace(/\bevery month\b|\bmonthly\b/gi, '').trim();
  }

  const parsedDates = chrono.parse(taskText);
  let dueDate: string | undefined = undefined;

  if (parsedDates.length > 0) {
    const parsed = parsedDates[0];
    let dateObj = parsed.date();

    if (!parsed.start.isCertain('meridiem')) {
      const hours = dateObj.getHours();
      if (hours >= 1 && hours <= 11) {
        dateObj.setHours(hours + 12);
      }
    }

    dueDate = formatDate(dateObj);
    taskText = taskText.replace(parsed.text, '').trim();
  }

  taskText = taskText.replace(/\s+(by|on|at|for|to)$/i, '').trim();

  if (taskText.length > 0) {
    return { isTask: true, taskText, dueDate, recurring };
  }

  return { isTask: false };
}

// --- WhatsApp Client Configuration ---
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "nudge-bot-session" }),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
  puppeteer: {
    headless: true,
    bypassCSP: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-web-security',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    ]
  }
});

client.on('qr', (qr) => {
  console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP ---');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Nudge is online and ready!');

  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const formattedNow = formatDate(now);

    for (const sender in tasksDB) {
      for (const task of tasksDB[sender]) {
        if (task.dueDate && task.dueDate <= formattedNow && !task.reminded) {
          try {
            const recurringNote = task.recurring ? ` _(Recurring: ${task.recurring})_` : '';
            await client.sendMessage(sender, `⏰ *NUDGE REMINDER*\n\n📌 "${task.text}" is due now!${recurringNote}`);
            
            if (task.recurring) {
              task.dueDate = computeNextRecurrence(task.dueDate, task.recurring);
              task.reminded = false;
            } else {
              task.reminded = true;
            }
            saveTasks(tasksDB);
          } catch (err) {
            console.error('Error sending scheduled reminder:', err);
          }
        }
      }
    }
  });
});

// --- Auto-Reject Calls ---
client.on('incoming_call', async (call) => {
  try {
    await call.reject();
    await client.sendMessage(
      call.from,
      "🤖 *Nudge Assistant*\n\nSorry, this number is an automated task assistant and does not accept voice or video calls. Please send your task or reminder as a text message!"
    );
  } catch (err) {
    console.error('Error handling incoming call:', err);
  }
});

client.on('message_create', async (msg) => {
  if (msg.from === 'status@broadcast' || msg.isStatus) return;

  if (msg.fromMe && (msg.body.startsWith('👋') || msg.body.startsWith('✅') || msg.body.startsWith('⏰') || msg.body.startsWith('🎉') || msg.body.startsWith('✏️') || msg.body.startsWith('🗑️') || msg.body.startsWith('🤖') || msg.body.includes('BEGIN:VCARD'))) {
    return;
  }

  const sender = msg.from;
  const trimText = msg.body.trim();
  const lowerText = trimText.toLowerCase();
  const currentTime = Date.now();

  if (!tasksDB[sender]) {
    tasksDB[sender] = [];
  }

  const userTasks = tasksDB[sender];

  const sendReply = async (text: string) => {
    try {
      await client.sendMessage(sender, text);
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  };

  const menuText = 
    "👋 *Welcome to Nudge*\n" +
    "\"Tell it what to do, tell it when, and let it remember and remind you.\"\n\n" +
    "*➕ Add a task*\n" +
    "• *Hey Nudge, remind me to call John at 4pm*\n" +
    "• *add review streetwear mockups*\n" +
    "• *remind me every Monday at 8am to submit report*\n\n" +
    "*📋 View tasks*\n" +
    "• *my tasks* — View all tasks\n" +
    "• *today* — View tasks due today\n" +
    "• *tomorrow* — View tasks due tomorrow\n" +
    "• *this week* — View tasks due this week\n" +
    "• *overdue* — View overdue tasks\n\n" +
    "*⚙️ Manage tasks*\n" +
    "• *done 1* or *done call John* — Complete a task\n" +
    "• *edit 1 to tomorrow at 4pm* — Reschedule a task\n" +
    "• *delete 1* — Remove a task\n" +
    "• *clear my tasks* — Delete all tasks";

  // Check 2-hour inactivity
  const lastActiveTime = lastActiveDB[sender];
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const isNewOrInactive = !lastActiveTime || (currentTime - lastActiveTime > TWO_HOURS_MS);

  // Update last active timestamp
  lastActiveDB[sender] = currentTime;
  saveLastActive(lastActiveDB);

  // 1. Explicit Menu Requests or Inactivity Welcome (with vCard)
  const explicitMenuTriggers = ['hi nudge', 'nudge', 'home', 'hi', 'help', 'menu', 'hello nudge', 'hey nudge'];
  if (explicitMenuTriggers.includes(lowerText) || (isNewOrInactive && !parseIncomingMessage(trimText).isTask)) {
    try {
      // Send vCard contact card
      const botNumber = client.info?.wid?.user || '';
      const vCard = 
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        'FN:Nudge\n' +
        'ORG:Task Assistant;\n' +
        `TEL;type=CELL;type=VOICE;waid=${botNumber}:+${botNumber}\n` +
        'END:VCARD';

      await client.sendMessage(sender, vCard, { parseVCards: true });
    } catch (err) {
      console.error('vCard send error:', err);
    }

    await sendReply(menuText);
    return;
  }

  // 2. View Tasks / Overviews
  if (['my tasks', 'view', 'list'].includes(lowerText)) {
    if (userTasks.length === 0) {
      await sendReply("📌 You don't have any active tasks!");
      return;
    }
    let listMsg = "📋 *All Your Tasks:*\n\n";
    userTasks.forEach((t, idx) => {
      const due = t.dueDate ? ` ⏰ _(${t.dueDate})_` : '';
      const rec = t.recurring ? ` 🔄 _[${t.recurring}]_` : '';
      listMsg += `${idx + 1}. ${t.text}${due}${rec}\n`;
    });
    await sendReply(listMsg);
    return;
  }

  if (lowerText === 'today' || lowerText === 'what do i have to do today?') {
    const todayStr = formatDate(new Date()).split(' ')[0];
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate.startsWith(todayStr));
    if (filtered.length === 0) {
      await sendReply("🎉 No tasks scheduled for today!");
      return;
    }
    let msgText = "📅 *Tasks Due Today:*\n\n";
    filtered.forEach((t, i) => { msgText += `${i + 1}. ${t.text} ⏰ _(${t.dueDate})_\n`; });
    await sendReply(msgText);
    return;
  }

  if (lowerText === 'tomorrow') {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = formatDate(tomorrow).split(' ')[0];
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate.startsWith(tomorrowStr));
    if (filtered.length === 0) {
      await sendReply("🎉 No tasks scheduled for tomorrow!");
      return;
    }
    let msgText = "📅 *Tasks Due Tomorrow:*\n\n";
    filtered.forEach((t, i) => { msgText += `${i + 1}. ${t.text} ⏰ _(${t.dueDate})_\n`; });
    await sendReply(msgText);
    return;
  }

  if (lowerText === 'this week') {
    const now = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(now.getDate() + 7);
    const filtered = userTasks.filter(t => t.dueDate && new Date(t.dueDate.replace(' ', 'T')) <= nextWeek);
    if (filtered.length === 0) {
      await sendReply("🎉 No tasks scheduled for this week!");
      return;
    }
    let msgText = "📅 *Tasks Due This Week:*\n\n";
    filtered.forEach((t, i) => { msgText += `${i + 1}. ${t.text} ⏰ _(${t.dueDate})_\n`; });
    await sendReply(msgText);
    return;
  }

  if (lowerText === 'overdue') {
    const nowStr = formatDate(new Date());
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate < nowStr && !t.reminded);
    if (filtered.length === 0) {
      await sendReply("✅ No overdue tasks!");
      return;
    }
    let msgText = "⚠️ *Overdue Tasks:*\n\n";
    filtered.forEach((t, i) => { msgText += `${i + 1}. ${t.text} ⏰ _(${t.dueDate})_\n`; });
    await sendReply(msgText);
    return;
  }

  // 3. Edit / Reschedule
  if (lowerText.startsWith('edit ')) {
    const parts = trimText.slice(5).split(' to ');
    if (parts.length < 2) {
      await sendReply("❌ Usage: *edit 1 to tomorrow at 4pm*");
      return;
    }
    const index = parseInt(parts[0].trim()) - 1;
    const newContent = parts[1].trim();

    if (isNaN(index) || index < 0 || index >= userTasks.length) {
      await sendReply("❌ Invalid task number. Type *my tasks* to check numbers.");
      return;
    }

    const parsed = parseIncomingMessage(`remind ${newContent}`);
    if (parsed.dueDate) {
      userTasks[index].dueDate = parsed.dueDate;
      if (parsed.taskText && parsed.taskText !== newContent) {
        userTasks[index].text = parsed.taskText;
      }
    } else {
      userTasks[index].text = newContent;
    }
    userTasks[index].reminded = false;
    saveTasks(tasksDB);

    const dueStr = userTasks[index].dueDate ? ` ⏰ _(${userTasks[index].dueDate})_` : '';
    await sendReply(`✏️ Task updated: "${userTasks[index].text}"${dueStr}`);
    return;
  }

  // 4. Complete Task
  const doneTriggers = ['i have done ', 'i have completed ', 'completed ', 'done '];
  const matchedDone = doneTriggers.find(t => lowerText.startsWith(t));
  if (matchedDone) {
    const query = trimText.slice(matchedDone.length).trim();
    if (!query || userTasks.length === 0) {
      await sendReply("📌 You don't have active tasks to complete!");
      return;
    }
    const index = parseInt(query) - 1;
    if (!isNaN(index) && index >= 0 && index < userTasks.length) {
      const removed = userTasks.splice(index, 1);
      saveTasks(tasksDB);
      await sendReply(`🎉 Completed: "${removed[0].text}"`);
      return;
    }
    const foundIdx = userTasks.findIndex(t => t.text.toLowerCase().includes(query.toLowerCase()));
    if (foundIdx !== -1) {
      const removed = userTasks.splice(foundIdx, 1);
      saveTasks(tasksDB);
      await sendReply(`🎉 Completed: "${removed[0].text}"`);
      return;
    }
    await sendReply(`❌ Could not find a task matching "${query}". Type *my tasks* to check active tasks.`);
    return;
  }

  // 5. Delete Task
  if (lowerText.startsWith('delete ')) {
    const index = parseInt(trimText.split(' ')[1]) - 1;
    if (!isNaN(index) && index >= 0 && index < userTasks.length) {
      const removed = userTasks.splice(index, 1);
      saveTasks(tasksDB);
      await sendReply(`🗑️ Deleted task: "${removed[0].text}"`);
    } else {
      await sendReply("❌ Invalid task number. Type *my tasks* to check numbers.");
    }
    return;
  }

  if (['clear my tasks', 'clear'].includes(lowerText)) {
    tasksDB[sender] = [];
    saveTasks(tasksDB);
    await sendReply("🧹 Cleared all your tasks!");
    return;
  }

  // 6. Natural Language Task Creation
  const parsed = parseIncomingMessage(trimText);
  if (parsed.isTask && parsed.taskText) {
    const newTask: Task = {
      id: Date.now(),
      text: parsed.taskText,
      dueDate: parsed.dueDate,
      reminded: false,
      recurring: parsed.recurring
    };

    userTasks.push(newTask);
    saveTasks(tasksDB);

    const timeMsg = parsed.dueDate ? `\n⏰ Reminder set for: *${parsed.dueDate}*` : '';
    const recMsg = parsed.recurring ? `\n🔄 Repeats: *${parsed.recurring}*` : '';
    await sendReply(`✅ Task added: "${parsed.taskText}"${timeMsg}${recMsg}`);
  }
});

client.initialize();