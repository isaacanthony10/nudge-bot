import express from 'express';
import axios from 'axios';
import * as chrono from 'chrono-node';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// --- Meta API Configuration ---
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'nudge_secret_token_123';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || 'EAAonTJzytS4BSa2Y9CZBWYjfaM1rsZAmaMj6rci1bShFUBXd42PBU42ZA6R2HkoUW3JZBbrM4f1cV7B35pgUpqmGlTiKYYOLth0BtqqG2Kba74nb4B3t4lw2AWlBLLmRdDk9867ZBMZCTrfZAEAe4lcX8hXA4emzuxqTUZB4mQvxxBMQJOlZCwAEnB4Q3ZBBIZBuejvFgZDZD';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '1228178750389271';

const TASKS_FILE = path.join(__dirname, '..', 'tasks.json');

export interface Task {
  id: number;
  text: string;
  dueDate?: string; // Format: YYYY-MM-DD HH:mm
  reminded?: boolean;
  recurring?: 'daily' | 'weekly' | 'monthly' | null;
}

// --- Data Persistence Helpers ---
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

const tasksDB: Record<string, Task[]> = loadTasks();

// --- Date Helper Functions ---
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

// --- Task Natural Language Parser ---
function parseIncomingMessage(userPrompt: string): {
  isTask: boolean;
  taskText?: string;
  dueDate?: string;
  recurring?: 'daily' | 'weekly' | 'monthly' | null;
} {
  let trimPrompt = userPrompt.trim();
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

// --- Outbound Message Sender ---
async function sendWhatsAppMessage(to: string, messageText: string) {
  try {
    await axios.post(
      `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: messageText },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error: any) {
    console.error('❌ Error sending WhatsApp message:', error.response?.data || error.message);
  }
}

// --- Webhook GET Handshake ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Meta Webhook verified successfully!');
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.sendStatus(403);
});

// --- Webhook POST Message Listener ---
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const message = value?.messages?.[0];

  if (!message || message.type !== 'text') return;

  const sender = message.from;
  const trimText = message.text.body.trim();
  const lowerText = trimText.toLowerCase();

  if (!tasksDB[sender]) {
    tasksDB[sender] = [];
  }
  const userTasks = tasksDB[sender];

  const cleanLowerText = lowerText.replace(/[^\w\s]/gi, '').trim();

  // --- Polite Acknowledgments / Thank You Responses ---
  const thankTriggers = [
    'thanks',
    'thank you',
    'okay thank you',
    'ok thank you',
    'okay thanks',
    'ok thanks',
    'thx',
    'cool thanks',
    'alright thank you',
    'thank you nudge'
  ];
  if (thankTriggers.includes(cleanLowerText)) {
    await sendWhatsAppMessage(sender, "😊 You're welcome! Let me know whenever you need Nudge.");
    return;
  }

  // 1. Menu & Welcomes
  const menuTriggers = [
    'hi',
    'hi nudge',
    'hey',
    'hey nudge',
    'hello',
    'hello nudge',
    'menu',
    'help',
    'nudge'
  ];

  if (menuTriggers.includes(cleanLowerText)) {
    const menuText =
      "👋 *Welcome to Nudge*\n" +
      "\"Tell it what to do, tell it when, and let it remember and remind you.\"\n\n" +
      "*➕ Add a task*\n" +
      "• *Hey Nudge, remind me to call John at 4pm*\n" +
      "• *add review streetwear mockups*\n" +
      "• *remind me every Monday at 8am to submit report*\n\n" +
      "*📋 View tasks*\n" +
      "• *my tasks* — View all tasks\n" +
      "• *my tasks for today* or *today*\n" +
      "• *my tasks for tomorrow* or *tomorrow*\n" +
      "• *my tasks for this week* or *this week*\n" +
      "• *overdue tasks* or *overdue*\n\n" +
      "*⚙️ Manage tasks*\n" +
      "• *done 1* or *done call John* — Complete a task\n" +
      "• *edit 1 to tomorrow at 4pm* — Reschedule a task\n" +
      "• *delete 1* — Remove a task\n" +
      "• *clear my tasks* — Delete all tasks";
    await sendWhatsAppMessage(sender, menuText);
    return;
  }

  // 2. View Tasks (Flexible Matching)
  if (['my tasks', 'list', 'view', 'all tasks', 'show tasks'].includes(cleanLowerText)) {
    if (userTasks.length === 0) {
      await sendWhatsAppMessage(sender, "📌 You don't have any active tasks!");
      return;
    }
    let listMsg = "📋 *All Your Tasks:*\n\n";
    userTasks.forEach((t, idx) => {
      const due = t.dueDate ? ` ⏰ _(${t.dueDate})_` : '';
      const rec = t.recurring ? ` 🔄 _[${t.recurring}]_` : '';
      listMsg += `${idx + 1}. ${t.text}${due}${rec}\n`;
    });
    await sendWhatsAppMessage(sender, listMsg);
    return;
  }

  if (['today', 'my tasks for today', 'tasks for today', 'show tasks for today'].includes(cleanLowerText)) {
    const todayStr = formatDate(new Date()).split(' ')[0];
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate.startsWith(todayStr));
    if (filtered.length === 0) {
      await sendWhatsAppMessage(sender, "🎉 No tasks scheduled for today!");
      return;
    }
    let msgText = "📅 *Tasks Due Today:*\n\n";
    filtered.forEach((t, i) => { msgText += `${i + 1}. ${t.text} ⏰ _(${t.dueDate})_\n`; });
    await sendWhatsAppMessage(sender, msgText);
    return;
  }

  if (['tomorrow', 'my tasks for tomorrow', 'tasks for tomorrow', 'show tasks for tomorrow'].includes(cleanLowerText)) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = formatDate(tomorrow).split(' ')[0];
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate.startsWith(tomorrowStr));
    if (filtered.length === 0) {
      await sendWhatsAppMessage(sender, "🎉 No tasks scheduled for tomorrow!");
      return;
    }
    let msgText = "📅 *Tasks Due Tomorrow:*\n\n";
    filtered.forEach((t, i) => { msgText += `${i + 1}. ${t.text} ⏰ _(${t.dueDate})_\n`; });
    await sendWhatsAppMessage(sender, msgText);
    return;
  }

  if (['this week', 'my tasks for this week', 'tasks for this week', 'show tasks for this week'].includes(cleanLowerText)) {
    const now = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(now.getDate() + 7);
    const filtered = userTasks.filter(t => t.dueDate && new Date(t.dueDate.replace(' ', 'T')) <= nextWeek);
    if (filtered.length === 0) {
      await sendWhatsAppMessage(sender, "🎉 No tasks scheduled for this week!");
      return;
    }
    let msgText = "📅 *Tasks Due This Week:*\n\n";
    filtered.forEach((t, i) => { msgText += `${i + 1}. ${t.text} ⏰ _(${t.dueDate})_\n`; });
    await sendWhatsAppMessage(sender, msgText);
    return;
  }

  if (['overdue', 'overdue tasks', 'my overdue tasks', 'show overdue tasks'].includes(cleanLowerText)) {
    const nowStr = formatDate(new Date());
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate < nowStr && !t.reminded);
    if (filtered.length === 0) {
      await sendWhatsAppMessage(sender, "✅ No overdue tasks!");
      return;
    }
    let msgText = "⚠️ *Overdue Tasks:*\n\n";
    filtered.forEach((t, i) => { msgText += `${i + 1}. ${t.text} ⏰ _(${t.dueDate})_\n`; });
    await sendWhatsAppMessage(sender, msgText);
    return;
  }

  // 3. Edit / Reschedule
  if (lowerText.startsWith('edit ')) {
    const parts = trimText.slice(5).split(' to ');
    if (parts.length < 2) {
      await sendWhatsAppMessage(sender, "❌ Usage: *edit 1 to tomorrow at 4pm*");
      return;
    }
    const index = parseInt(parts[0].trim()) - 1;
    const newContent = parts[1].trim();

    if (isNaN(index) || index < 0 || index >= userTasks.length) {
      await sendWhatsAppMessage(sender, "❌ Invalid task number. Type *my tasks* to check numbers.");
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
    await sendWhatsAppMessage(sender, `✏️ Task updated: "${userTasks[index].text}"${dueStr}`);
    return;
  }

  // 4. Complete Tasks
  const doneTriggers = ['i have done ', 'i have completed ', 'completed ', 'done '];
  const matchedDone = doneTriggers.find(t => lowerText.startsWith(t));
  if (matchedDone) {
    const query = trimText.slice(matchedDone.length).trim();
    if (!query || userTasks.length === 0) {
      await sendWhatsAppMessage(sender, "📌 You don't have active tasks to complete!");
      return;
    }
    const index = parseInt(query) - 1;
    if (!isNaN(index) && index >= 0 && index < userTasks.length) {
      const removed = userTasks.splice(index, 1);
      saveTasks(tasksDB);
      await sendWhatsAppMessage(sender, `🎉 Completed: "${removed[0].text}"`);
      return;
    }
    const foundIdx = userTasks.findIndex(t => t.text.toLowerCase().includes(query.toLowerCase()));
    if (foundIdx !== -1) {
      const removed = userTasks.splice(foundIdx, 1);
      saveTasks(tasksDB);
      await sendWhatsAppMessage(sender, `🎉 Completed: "${removed[0].text}"`);
      return;
    }
    await sendWhatsAppMessage(sender, `❌ Could not find a task matching "${query}". Type *my tasks* to check active tasks.`);
    return;
  }

  // 5. Delete Task
  if (lowerText.startsWith('delete ')) {
    const index = parseInt(trimText.split(' ')[1]) - 1;
    if (!isNaN(index) && index >= 0 && index < userTasks.length) {
      const removed = userTasks.splice(index, 1);
      saveTasks(tasksDB);
      await sendWhatsAppMessage(sender, `🗑️ Deleted task: "${removed[0].text}"`);
    } else {
      await sendWhatsAppMessage(sender, "❌ Invalid task number. Type *my tasks* to check numbers.");
    }
    return;
  }

  if (['clear my tasks', 'clear'].includes(cleanLowerText)) {
    tasksDB[sender] = [];
    saveTasks(tasksDB);
    await sendWhatsAppMessage(sender, "🧹 Cleared all your tasks!");
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
    await sendWhatsAppMessage(sender, `✅ Task added: "${parsed.taskText}"${timeMsg}${recMsg}`);
  }
});

// --- Scheduled Cron Job for Automated Reminders ---
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const formattedNow = formatDate(now);

  for (const sender in tasksDB) {
    for (const task of tasksDB[sender]) {
      if (task.dueDate && task.dueDate <= formattedNow && !task.reminded) {
        try {
          const recurringNote = task.recurring ? ` _(Recurring: ${task.recurring})_` : '';
          await sendWhatsAppMessage(sender, `⏰ *NUDGE REMINDER*\n\n📌 "${task.text}" is due now!${recurringNote}`);
          
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

app.listen(3000, () => {
  console.log('🚀 Nudge Cloud API Server listening on port 3000');
});