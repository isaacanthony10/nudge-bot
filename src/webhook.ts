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

// --- Meta & Deepgram API Configuration ---
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'nudge_secret_token_123';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';

const TASKS_FILE = path.join(__dirname, '..', 'tasks.json');

export interface Task {
  id: number;
  text: string;
  dueDate?: string; // Format: YYYY-MM-DD HH:mm
  reminded?: boolean;
  recurring?: 'daily' | 'weekly' | 'monthly' | null;
}

export interface UserProfile {
  name?: string;
  hasBeenWelcomed?: boolean;
  tasks: Task[];
}

// --- Data Persistence Helpers ---
function loadDatabase(): Record<string, UserProfile> {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const rawData = fs.readFileSync(TASKS_FILE, 'utf-8');
      const parsed = JSON.parse(rawData);

      // Migrates old legacy schema (Record<string, Task[]>) to UserProfile if needed
      const migrated: Record<string, UserProfile> = {};
      for (const key in parsed) {
        if (Array.isArray(parsed[key])) {
          migrated[key] = { name: 'there', hasBeenWelcomed: false, tasks: parsed[key] };
        } else {
          migrated[key] = parsed[key];
        }
      }
      return migrated;
    }
  } catch (error) {
    console.error('Error loading tasks database:', error);
  }
  return {};
}

function saveDatabase(db: Record<string, UserProfile>) {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving tasks database:', error);
  }
}

const db: Record<string, UserProfile> = loadDatabase();
const pendingMoveSession: Record<string, number> = {};

// --- Timezone Helper Functions ---
const TIMEZONE = 'Africa/Lagos';

function formatDate(d: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };

  const formatter = new Intl.DateTimeFormat('en-GB', options);
  const parts = formatter.formatToParts(d);
  
  const partMap: Record<string, string> = {};
  parts.forEach(p => { if (p.type !== 'literal') partMap[p.type] = p.value; });

  return `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}`;
}

function formatFriendlyTime(dueDateStr: string, includeDate: boolean = false): string {
  const [datePart, timePart] = dueDateStr.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours24, minutes] = timePart.split(':').map(Number);

  const hours12 = hours24 % 12 || 12;
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const formattedMinutes = String(minutes).padStart(2, '0');

  const timeString = `${hours12}:${formattedMinutes} ${ampm}`;

  if (includeDate) {
    const todayStr = formatDate(new Date()).split(' ')[0];
    
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = formatDate(tomorrow).split(' ')[0];

    if (datePart === todayStr) {
      return `${timeString} today`;
    } else if (datePart === tomorrowStr) {
      return `${timeString} tomorrow`;
    } else {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${timeString} on ${months[month - 1]} ${day}`;
    }
  }

  return timeString;
}

function cleanTaskTitle(text: string): string {
  return text
    .replace(/[\s\.,]+(by|on|at|for|to)[\s\.,]*$/i, '')
    .replace(/\b(by|on|at|for|to)$/i, '')
    .replace(/[\s\.,]+$/, '')
    .trim();
}

function sortTasksChronologically(tasks: Task[]): Task[] {
  return [...tasks].sort((a: Task, b: Task) => {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });
}

function addMinutesToDueDate(dueDateStr: string, mins: number): string {
  const [datePart, timePart] = dueDateStr.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);

  const d = new Date(year, month - 1, day, hours, minutes);
  d.setMinutes(d.getMinutes() + mins);
  return formatDate(d);
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

// --- Universal Task Natural Language Parser ---
function parseIncomingMessage(userPrompt: string): {
  isTask: boolean;
  taskText?: string;
  dueDate?: string;
  recurring?: 'daily' | 'weekly' | 'monthly' | null;
} {
  let trimPrompt = userPrompt.trim();
  
  trimPrompt = trimPrompt.replace(/^(hey|hi|hello|yo)?\s*nudge[,:]?\s*/i, '').trim();
  const lowerPrompt = trimPrompt.toLowerCase();
  const cleanLower = lowerPrompt.replace(/[^\w\s]/gi, '').trim();

  const exactSystemCommands = [
    'my tasks', 'my task', 'show my task', 'show my tasks', 'show me my task', 'show me all my tasks', 'show me my tasks', 'show me all my task', 'i want to see all my tasks', 'i want to view all my tasks', 'list', 'view', 'all tasks', 'show tasks',
    'today', 'tomorrow', 'this week', 'overdue',
    'clear my tasks', 'clear', 'help', 'menu', 'hi', 'hello', 'hey', 'thanks', 'thank you', 'go to menu',
    'completed tasks', 'move task', 'delete task', 'completed task', 'delete tasks', 'done',
    'stats', 'admin stats'
  ];

  if (exactSystemCommands.includes(cleanLower)) {
    return { isTask: false };
  }

  let extractedTask = trimPrompt.replace(
    /^(i (do )?(need|have|want|got) to|remind me (for|about|to)?|please|don't forget to|make sure to|i'm supposed to|add task|add|todo)\s+/i,
    ''
  ).trim();

  let recurring: 'daily' | 'weekly' | 'monthly' | null = null;
  if (/\bevery day\b|\bdaily\b/i.test(extractedTask)) {
    recurring = 'daily';
    extractedTask = extractedTask.replace(/\bevery day\b|\bdaily\b/gi, '').trim();
  } else if (/\bevery week\b|\bweekly\b|\bevery monday\b|\bevery tuesday\b|\bevery wednesday\b|\bevery thursday\b|\bevery friday\b|\bevery saturday\b|\bevery sunday\b/i.test(extractedTask)) {
    recurring = 'weekly';
    extractedTask = extractedTask.replace(/\bevery week\b|\bweekly\b/gi, '').trim();
  } else if (/\bevery month\b|\bmonthly\b/i.test(extractedTask)) {
    recurring = 'monthly';
    extractedTask = extractedTask.replace(/\bevery month\b|\bmonthly\b/gi, '').trim();
  }

  const parsedDates = chrono.parse(extractedTask);
  let dueDate: string | undefined = undefined;

  if (parsedDates.length > 0) {
    const parsed = parsedDates[0];
    const comp = parsed.start;

    const targetDate = new Date();
    if (/\btomorrow\b/i.test(extractedTask)) {
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (comp.isCertain('day') && comp.get('day') !== null) {
      if (comp.get('year')) targetDate.setFullYear(comp.get('year')!);
      if (comp.get('month')) targetDate.setMonth(comp.get('month')! - 1);
      targetDate.setDate(comp.get('day')!);
    }

    let hours = comp.get('hour') ?? 9;
    const minutes = comp.get('minute') ?? 0;
    const meridiem = comp.get('meridiem');

    if (meridiem === 1 && hours < 12) {
      hours += 12;
    } else if (meridiem === 0 && hours === 12) {
      hours = 0;
    } else if (!comp.isCertain('meridiem') && hours >= 1 && hours <= 11) {
      if (/\b(am)\b/i.test(extractedTask)) {
        // explicit AM
      } else if (/\b(pm)\b/i.test(extractedTask) || hours <= 7) {
        hours += 12;
      }
    }

    const YYYY = targetDate.getFullYear();
    const MM = String(targetDate.getMonth() + 1).padStart(2, '0');
    const DD = String(targetDate.getDate()).padStart(2, '0');
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');

    dueDate = `${YYYY}-${MM}-${DD} ${hh}:${mm}`;
    extractedTask = extractedTask.replace(parsed.text, '').trim();
  }

  extractedTask = cleanTaskTitle(extractedTask);

  if (extractedTask.length > 0) {
    extractedTask = extractedTask.charAt(0).toUpperCase() + extractedTask.slice(1);
    return { isTask: true, taskText: extractedTask.trim(), dueDate, recurring };
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

// --- Interactive Buttons Message Sender ---
async function sendWhatsAppButtons(to: string, text: string, buttons: { id: string; title: string }[]) {
  try {
    await axios.post(
      `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: text },
          action: {
            buttons: buttons.map(b => ({
              type: 'reply',
              reply: { id: b.id, title: b.title }
            }))
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error: any) {
    console.error('❌ Error sending WhatsApp buttons:', error.response?.data || error.message);
  }
}

// --- Interactive List (Dropdown) Message Sender ---
async function sendWhatsAppList(
  to: string, 
  bodyText: string, 
  buttonTitle: string, 
  items: { id: string; title: string; description?: string }[]
) {
  try {
    await axios.post(
      `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: buttonTitle,
            sections: [
              {
                title: 'Select a Task',
                rows: items.map(item => ({
                  id: item.id,
                  title: item.title.slice(0, 24),
                  description: item.description ? item.description.slice(0, 72) : undefined
                }))
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error: any) {
    console.error('❌ Error sending WhatsApp list:', error.response?.data || error.message);
  }
}

// --- Render Health Check Endpoint ---
app.get('/', (req, res) => {
  res.status(200).send('🚀 Nudge Webhook Server is active and healthy!');
});

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

  if (!message || (message.type !== 'text' && message.type !== 'audio' && message.type !== 'interactive')) return;

  const sender = message.from;

  // Extract WhatsApp Profile Name
  const contact = value?.contacts?.[0];
  const rawName = contact?.profile?.name || '';
  const firstName = rawName.trim() ? rawName.trim().split(' ')[0] : 'there';

  // Initialize profile record if new
  if (!db[sender]) {
    db[sender] = {
      name: firstName,
      hasBeenWelcomed: false,
      tasks: []
    };
    saveDatabase(db);
  } else if (rawName && db[sender].name !== firstName) {
    db[sender].name = firstName;
    saveDatabase(db);
  }

  const userTasks = db[sender].tasks;

  // Helper function to send full help menu
  const sendHelpMenu = async (to: string) => {
    const menuMsg = 
      "Nudge Help Menu\n\n" +
      "💡 Here’s what you can do with Nudge:\n" +
      "➕ *Add*\n" +
      "Tell me what you need to remember and when.\n\n" +
      "📋 *View*\n" +
      "Say:\n" +
      "• “My tasks”\n\n" +
      "⚙️ *Manage*\n" +
      "You can also say:\n" +
      "• “Completed tasks”\n" +
      "• “Move task”\n" +
      "• “Delete task”\n" +
      "• “Clear my tasks”\n\n" +
      "💬 No complicated commands. Just talk to me naturally.";
    await sendWhatsAppMessage(to, menuMsg);
  };

  // Helper function for onboarding welcome card
  const sendOnboardingCard = async (to: string, name: string) => {
    const welcomeText = 
      `👋 *Hi ${name}! Welcome to Nudge.*\n\n` +
      `I'm your personal task assistant. I can help you stay on top of your reminders and daily to-dos!\n\n` +
      `*Here’s what you can do:*\n` +
      `🎙️ *Voice Notes:* Send a voice note like _"Remind me to call John at 5pm today"_.\n\n` +
      `✍️ *Text Commands:*\n` +
      `• _"Remind me to call John at 4pm"_\n` +
      `• _"Add review streetwear mockups"_\n` +
      `• _"Remind me every Monday to submit my report"_\n\n` +
      `What would you like to set a reminder for today?`;

    await sendWhatsAppButtons(
      to,
      welcomeText,
      [
        { id: 'btn_go_to_menu', title: '📋 Go To Menu' }
      ]
    );

    db[to].hasBeenWelcomed = true;
    saveDatabase(db);
  };

  // Trigger Onboarding for First-Time Users automatically
  if (!db[sender].hasBeenWelcomed) {
    await sendOnboardingCard(sender, firstName);
    return;
  }

  // --- Handle Interactive Selection Clicks (Buttons & Lists) ---
  if (message.type === 'interactive') {
    const interactiveObj = message.interactive;
    const buttonId = interactiveObj?.button_reply?.id;
    const listId = interactiveObj?.list_reply?.id;
    const selectedId = buttonId || listId;

    if (!selectedId) return;

    if (selectedId === 'btn_go_to_menu') {
      await sendHelpMenu(sender);
      return;
    }

    if (selectedId === 'btn_today') {
      const todayStr = formatDate(new Date()).split(' ')[0];
      const filtered = userTasks.filter(t => t.dueDate && t.dueDate.startsWith(todayStr));
      if (filtered.length === 0) {
        await sendWhatsAppMessage(sender, "🎉 No tasks scheduled for today!");
        return;
      }
      const sorted = sortTasksChronologically(filtered);
      let msgText = "📅 *Tasks Due Today:*\n\n";
      sorted.forEach((t, i) => { 
        const cleanTitle = cleanTaskTitle(t.text);
        const timeStr = t.dueDate ? ` ${formatFriendlyTime(t.dueDate, false)}` : '';
        msgText += `${i + 1}. ${cleanTitle}${timeStr}\n`; 
      });
      await sendWhatsAppMessage(sender, msgText);
      return;
    }

    if (selectedId === 'btn_tomorrow') {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = formatDate(tomorrow).split(' ')[0];
      const filtered = userTasks.filter(t => t.dueDate && t.dueDate.startsWith(tomorrowStr));
      if (filtered.length === 0) {
        await sendWhatsAppMessage(sender, "🎉 No tasks scheduled for tomorrow!");
        return;
      }
      const sorted = sortTasksChronologically(filtered);
      let msgText = "🚀 *Tasks Due Tomorrow:*\n\n";
      sorted.forEach((t, i) => { 
        const cleanTitle = cleanTaskTitle(t.text);
        const timeStr = t.dueDate ? ` ${formatFriendlyTime(t.dueDate, false)}` : '';
        msgText += `${i + 1}. ${cleanTitle}${timeStr}\n`; 
      });
      await sendWhatsAppMessage(sender, msgText);
      return;
    }

    if (selectedId === 'btn_overdue') {
      const nowStr = formatDate(new Date());
      const filtered = userTasks.filter(t => t.dueDate && t.dueDate < nowStr);
      if (filtered.length === 0) {
        await sendWhatsAppMessage(sender, "✅ No overdue tasks!");
        return;
      }
      const sorted = sortTasksChronologically(filtered);
      let msgText = "⚠️ *Overdue Tasks:*\n\n";
      sorted.forEach((t, i) => { 
        const cleanTitle = cleanTaskTitle(t.text);
        const timeStr = t.dueDate ? ` ${formatFriendlyTime(t.dueDate, true)}` : '';
        msgText += `${i + 1}. ${cleanTitle}${timeStr}\n`; 
      });
      await sendWhatsAppMessage(sender, msgText);
      return;
    }

    // 1. Completion Handler from List
    if (selectedId.startsWith('complete_task_')) {
      const taskId = parseInt(selectedId.replace('complete_task_', ''));
      const index = userTasks.findIndex(t => t.id === taskId);
      if (index !== -1) {
        const removed = userTasks.splice(index, 1);
        saveDatabase(db);
        await sendWhatsAppMessage(sender, `🎉 Task completed: "${cleanTaskTitle(removed[0].text)}"! It has been removed from your list.`);
      } else {
        await sendWhatsAppMessage(sender, "❌ Task not found or already completed!");
      }
      return;
    }

    // 2. Move Task Handler from List
    if (selectedId.startsWith('move_task_')) {
      const taskId = parseInt(selectedId.replace('move_task_', ''));
      const task = userTasks.find(t => t.id === taskId);
      if (task) {
        pendingMoveSession[sender] = taskId;
        await sendWhatsAppMessage(sender, `🗓️ Moving task: "${cleanTaskTitle(task.text)}".\n\nWhen would you like to move it to? (e.g. "tomorrow at 4pm", "next Monday at 8am", or send a voice note)`);
      } else {
        await sendWhatsAppMessage(sender, "❌ Task not found!");
      }
      return;
    }

    // 3. Delete Task Handler from List
    if (selectedId.startsWith('delete_task_')) {
      const taskId = parseInt(selectedId.replace('delete_task_', ''));
      const index = userTasks.findIndex(t => t.id === taskId);
      if (index !== -1) {
        const removed = userTasks.splice(index, 1);
        saveDatabase(db);
        await sendWhatsAppMessage(sender, `🗑️ Deleted successfully: "${cleanTaskTitle(removed[0].text)}"`);
      } else {
        await sendWhatsAppMessage(sender, "❌ Task not found or already deleted!");
      }
      return;
    }

    // 4. Clear All Confirmation Handlers
    if (selectedId === 'btn_confirm_clear') {
      db[sender].tasks = [];
      saveDatabase(db);
      await sendWhatsAppMessage(sender, "🧹 All your tasks have been cleared successfully!");
      return;
    }

    if (selectedId === 'btn_cancel_clear') {
      await sendWhatsAppMessage(sender, "👍 Action canceled. Your tasks are safe!");
      return;
    }

    // Interactive Snooze Button Handlers
    if (selectedId.startsWith('snz_15m_')) {
      const taskId = parseInt(selectedId.replace('snz_15m_', ''));
      const task = userTasks.find(t => t.id === taskId);
      if (task) {
        const nowStr = formatDate(new Date());
        task.dueDate = addMinutesToDueDate(nowStr, 15);
        task.reminded = false;
        saveDatabase(db);
        await sendWhatsAppMessage(sender, `⏱️ Snoozed "${cleanTaskTitle(task.text)}" for 15 minutes! (${formatFriendlyTime(task.dueDate, true)})`);
      }
      return;
    }

    if (selectedId.startsWith('snz_1h_')) {
      const taskId = parseInt(selectedId.replace('snz_1h_', ''));
      const task = userTasks.find(t => t.id === taskId);
      if (task) {
        const nowStr = formatDate(new Date());
        task.dueDate = addMinutesToDueDate(nowStr, 60);
        task.reminded = false;
        saveDatabase(db);
        await sendWhatsAppMessage(sender, `⏰ Snoozed "${cleanTaskTitle(task.text)}" for 1 hour! (${formatFriendlyTime(task.dueDate, true)})`);
      }
      return;
    }

    if (selectedId.startsWith('snz_tom_')) {
      const taskId = parseInt(selectedId.replace('snz_tom_', ''));
      const task = userTasks.find(t => t.id === taskId);
      if (task) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = formatDate(tomorrow).split(' ')[0];
        const currentTime = task.dueDate ? task.dueDate.split(' ')[1] : '09:00';
        task.dueDate = `${tomorrowStr} ${currentTime}`;
        task.reminded = false;
        saveDatabase(db);
        await sendWhatsAppMessage(sender, `🚀 Snoozed "${cleanTaskTitle(task.text)}" to tomorrow! (${formatFriendlyTime(task.dueDate, true)})`);
      }
      return;
    }

    return;
  }

  // --- Handle Incoming Voice Notes via Deepgram REST API ---
  if (message.type === 'audio') {
    const mediaId = message.audio?.id;
    console.log(`🎙️ Voice note received from ${sender}! Media ID: ${mediaId}`);

    try {
      const mediaRes = await axios.get(
        `https://graph.facebook.com/v22.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
      );
      const mediaUrl = mediaRes.data.url;

      const audioBuffer = await axios.get(mediaUrl, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        responseType: 'arraybuffer'
      });

      const deepgramRes = await axios.post(
        'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
        Buffer.from(audioBuffer.data),
        {
          headers: {
            Authorization: `Token ${DEEPGRAM_API_KEY}`,
            'Content-Type': 'audio/ogg',
          },
        }
      );

      const transcribedText = deepgramRes.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      console.log(`🗣️ Transcribed Text: "${transcribedText}"`);

      if (!transcribedText.trim()) {
        await sendWhatsAppMessage(sender, "🤔 I heard your voice note, but couldn't detect any clear speech.");
        return;
      }

      await sendWhatsAppMessage(sender, `🎙️ _"${transcribedText}"_`);
      message.text = { body: transcribedText };

    } catch (err: any) {
      console.error('❌ Error processing voice note:', err.response?.data || err.message);
      await sendWhatsAppMessage(sender, "❌ Failed to process your voice note. Please check server logs!");
      return;
    }
  }

  // --- Safely Extract Text Messages ---
  const rawText = message.text?.body || '';
  const trimText = rawText.trim();
  const lowerText = trimText.toLowerCase();

  const cleanLowerText = lowerText.replace(/[^\w\s]/gi, '').trim();

  // --- Check Pending Reschedule Session ---
  if (pendingMoveSession[sender]) {
    const taskId = pendingMoveSession[sender];
    delete pendingMoveSession[sender];

    const task = userTasks.find(t => t.id === taskId);
    if (task) {
      const parsed = parseIncomingMessage(`remind ${trimText}`);
      if (parsed.dueDate) {
        task.dueDate = parsed.dueDate;
        task.reminded = false;
        saveDatabase(db);
        await sendWhatsAppMessage(sender, `✏️ Task successfully moved! "${cleanTaskTitle(task.text)}" is now scheduled for: *${formatFriendlyTime(task.dueDate, true)}*`);
      } else {
        await sendWhatsAppMessage(sender, `❌ Could not parse date/time from "${trimText}". Please try moving again.`);
      }
      return;
    }
  }

  // --- Admin Analytics Trigger ---
  if (cleanLowerText === 'stats' || cleanLowerText === 'admin stats') {
    const ADMIN_PHONE = process.env.ADMIN_PHONE_NUMBER || '';

    if (!ADMIN_PHONE || sender !== ADMIN_PHONE) {
      await sendWhatsAppMessage(sender, "❌ Command not recognized. Type *menu* or *help* to see available options.");
      return;
    }

    const totalUsers = Object.keys(db).length;
    
    let totalActiveTasks = 0;
    let totalOverdueTasks = 0;
    const nowStr = formatDate(new Date());

    Object.values(db).forEach(user => {
      totalActiveTasks += user.tasks.length;
      totalOverdueTasks += user.tasks.filter(t => t.dueDate && t.dueDate < nowStr).length;
    });

    const statsMsg = 
      "📊 *Nudge Bot Analytics*\n\n" +
      `👥 *Total Unique Users:* ${totalUsers}\n` +
      `📌 *Total Active Tasks:* ${totalActiveTasks}\n` +
      `⚠️ *Total Overdue Tasks:* ${totalOverdueTasks}`;

    await sendWhatsAppMessage(sender, statsMsg);
    return;
  }

  // --- Polite Acknowledgments ---
  const thankTriggers = [
    'thanks', 'thank you', 'okay thank you', 'ok thank you',
    'okay thanks', 'ok thanks', 'thx', 'cool thanks',
    'alright thank you', 'thank you nudge'
  ];
  if (thankTriggers.includes(cleanLowerText)) {
    await sendWhatsAppMessage(sender, "😊 You're welcome! Let me know whenever you need Nudge.");
    return;
  }

  // 1. Initial Greeting / Welcome Triggers
  const welcomeTriggers = ['hi', 'hi nudge', 'hey', 'hey nudge', 'hello', 'hello nudge', 'yo nudge'];
  if (welcomeTriggers.includes(cleanLowerText)) {
    await sendOnboardingCard(sender, firstName);
    return;
  }

  // 1b. Menu / Help Triggers
  if (['menu', 'help', 'go to menu'].includes(cleanLowerText)) {
    await sendHelpMenu(sender);
    return;
  }

  // 2. View Tasks - Interactive Button Card
  if (['my tasks', 'my task', 'show my task', 'show my tasks', 'show me my task', 'show me all my tasks', 'show me my tasks', 'show me all my task', 'i want to see all my tasks', 'i want to view all my tasks', 'list', 'view', 'tasks', 'show tasks'].includes(cleanLowerText)) {
    if (userTasks.length === 0) {
      await sendWhatsAppMessage(sender, "📌 You don't have any active tasks!");
      return;
    }
    
    await sendWhatsAppButtons(
      sender,
      "📋 *Which tasks would you like to view?*",
      [
        { id: 'btn_today', title: '📅 Today' },
        { id: 'btn_tomorrow', title: '🚀 Tomorrow' },
        { id: 'btn_overdue', title: '⚠️ Overdue' }
      ]
    );
    return;
  }

  // 3. Interactive Task Management Commands

  // 3a. Completed Tasks (List Selection & Case-Insensitive 'done' Catch)
  const doneTriggers = ['i have done ', 'i have completed ', 'completed ', 'done task ', 'done '];
  const matchedDone = doneTriggers.find(t => lowerText.startsWith(t));

  if (['completed tasks', 'completed task', 'completed'].includes(cleanLowerText) || matchedDone || cleanLowerText === 'done') {
    if (userTasks.length === 0) {
      await sendWhatsAppMessage(sender, "📌 You have no active tasks to complete!");
      return;
    }

    const query = matchedDone ? trimText.slice(matchedDone.length).replace(/task/i, '').trim() : '';

    if (!query || cleanLowerText === 'done' || ['completed tasks', 'completed task', 'completed'].includes(cleanLowerText)) {
      if (userTasks.length === 1) {
        const removed = userTasks.splice(0, 1);
        saveDatabase(db);
        await sendWhatsAppMessage(sender, `🎉 Task completed: "${cleanTaskTitle(removed[0].text)}"!`);
        return;
      }

      const items = sortTasksChronologically(userTasks).map((t, i) => ({
        id: `complete_task_${t.id}`,
        title: `${i + 1}. ${cleanTaskTitle(t.text)}`,
        description: t.dueDate ? formatFriendlyTime(t.dueDate, true) : 'No due date'
      }));

      await sendWhatsAppList(sender, "Which task did you complete?", "Choose Task", items);
      return;
    }

    const index = parseInt(query) - 1;
    if (!isNaN(index) && index >= 0 && index < userTasks.length) {
      const removed = userTasks.splice(index, 1);
      saveDatabase(db);
      await sendWhatsAppMessage(sender, `🎉 Task completed: "${cleanTaskTitle(removed[0].text)}"!`);
      return;
    }

    const foundIdx = userTasks.findIndex(t => t.text.toLowerCase().includes(query.toLowerCase()));
    if (foundIdx !== -1) {
      const removed = userTasks.splice(foundIdx, 1);
      saveDatabase(db);
      await sendWhatsAppMessage(sender, `🎉 Task completed: "${cleanTaskTitle(removed[0].text)}"!`);
      return;
    }

    await sendWhatsAppMessage(sender, `❌ Could not find a task matching "${query}". Type *my tasks* to check active tasks.`);
    return;
  }

  // 3b. Move Task (List Selection)
  if (['move task', 'move tasks', 'edit task', 'reschedule'].includes(cleanLowerText)) {
    if (userTasks.length === 0) {
      await sendWhatsAppMessage(sender, "📌 You have no active tasks to move!");
      return;
    }

    const items = sortTasksChronologically(userTasks).map((t, i) => ({
      id: `move_task_${t.id}`,
      title: `${i + 1}. ${cleanTaskTitle(t.text)}`,
      description: t.dueDate ? formatFriendlyTime(t.dueDate, true) : 'No due date'
    }));

    await sendWhatsAppList(sender, "Choose which task to move:", "Choose Task", items);
    return;
  }

  // 3c. Delete Tasks (List Selection & Multi-Delete Natural Language Parser)
  if (lowerText.startsWith('delete task') || lowerText.startsWith('delete tasks') || lowerText.startsWith('delete ')) {
    if (userTasks.length === 0) {
      await sendWhatsAppMessage(sender, "📌 You have no active tasks to delete!");
      return;
    }

    const rawNumbers = trimText.replace(/^delete\s+(tasks?\s+)?/i, '').trim();

    if (!rawNumbers || ['delete task', 'delete tasks', 'delete'].includes(cleanLowerText)) {
      const items = sortTasksChronologically(userTasks).map((t: Task, i: number) => ({
        id: `delete_task_${t.id}`,
        title: `${i + 1}. ${cleanTaskTitle(t.text)}`,
        description: t.dueDate ? formatFriendlyTime(t.dueDate, true) : 'No due date'
      }));

      await sendWhatsAppList(sender, "Choose which task to delete:", "Choose Task", items);
      return;
    }

    const sortedTasks = sortTasksChronologically(userTasks);
    const numbers = rawNumbers.match(/\d+/g);

    if (numbers && numbers.length > 0) {
      const indices: number[] = numbers
        .map((n: string): number => parseInt(n, 10) - 1)
        .filter((idx: number): boolean => idx >= 0 && idx < sortedTasks.length);
      
      if (indices.length > 0) {
        const idsToDelete: number[] = indices.map((idx: number): number => sortedTasks[idx].id);
        const removedTitles: string[] = [];

        db[sender].tasks = userTasks.filter((t: Task) => {
          if (idsToDelete.includes(t.id)) {
            removedTitles.push(cleanTaskTitle(t.text));
            return false;
          }
          return true;
        });

        saveDatabase(db);

        if (removedTitles.length === 1) {
          await sendWhatsAppMessage(sender, `🗑️ Deleted successfully: "${removedTitles[0]}"`);
        } else {
          await sendWhatsAppMessage(sender, `🗑️ Deleted ${removedTitles.length} tasks successfully:\n• ${removedTitles.join('\n• ')}`);
        }
        return;
      }
    }
  }

  // 3d. Clear All Tasks (Interactive Confirmation Card)
  if (['clear my tasks', 'clear', 'clear tasks', 'clear all'].includes(cleanLowerText)) {
    if (userTasks.length === 0) {
      await sendWhatsAppMessage(sender, "📌 You have no active tasks to clear!");
      return;
    }

    await sendWhatsAppButtons(
      sender,
      "⚠️ *Are you sure you want to clear all your tasks?*\nThis action cannot be undone.",
      [
        { id: 'btn_confirm_clear', title: '🔴 Are You Sure' },
        { id: 'btn_cancel_clear', title: '🟢 Cancel' }
      ]
    );
    return;
  }

  // 4. Text Queries for Specific Views
  if (cleanLowerText === 'today') {
    const todayStr = formatDate(new Date()).split(' ')[0];
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate.startsWith(todayStr));
    if (filtered.length === 0) {
      await sendWhatsAppMessage(sender, "🎉 No tasks scheduled for today!");
      return;
    }
    const sorted = sortTasksChronologically(filtered);
    let msgText = "📅 *Tasks Due Today:*\n\n";
    sorted.forEach((t, i) => { 
      const cleanTitle = cleanTaskTitle(t.text);
      const timeStr = t.dueDate ? ` ${formatFriendlyTime(t.dueDate, false)}` : '';
      msgText += `${i + 1}. ${cleanTitle}${timeStr}\n`; 
    });
    await sendWhatsAppMessage(sender, msgText);
    return;
  }

  if (cleanLowerText === 'tomorrow') {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = formatDate(tomorrow).split(' ')[0];
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate.startsWith(tomorrowStr));
    if (filtered.length === 0) {
      await sendWhatsAppMessage(sender, "🎉 No tasks scheduled for tomorrow!");
      return;
    }
    const sorted = sortTasksChronologically(filtered);
    let msgText = "🚀 *Tasks Due Tomorrow:*\n\n";
    sorted.forEach((t, i) => { 
      const cleanTitle = cleanTaskTitle(t.text);
      const timeStr = t.dueDate ? ` ${formatFriendlyTime(t.dueDate, false)}` : '';
      msgText += `${i + 1}. ${cleanTitle}${timeStr}\n`; 
    });
    await sendWhatsAppMessage(sender, msgText);
    return;
  }

  if (cleanLowerText === 'this week') {
    const now = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(now.getDate() + 7);
    const filtered = userTasks.filter(t => t.dueDate && new Date(t.dueDate.replace(' ', 'T')) <= nextWeek);
    if (filtered.length === 0) {
      await sendWhatsAppMessage(sender, "🎉 No tasks scheduled for this week!");
      return;
    }
    const sorted = sortTasksChronologically(filtered);
    let msgText = "📆 *Tasks Due This Week:*\n\n";
    sorted.forEach((t, i) => { 
      const cleanTitle = cleanTaskTitle(t.text);
      const timeStr = t.dueDate ? ` ${formatFriendlyTime(t.dueDate, true)}` : '';
      msgText += `${i + 1}. ${cleanTitle}${timeStr}\n`; 
    });
    await sendWhatsAppMessage(sender, msgText);
    return;
  }

  if (cleanLowerText === 'overdue') {
    const nowStr = formatDate(new Date());
    const filtered = userTasks.filter(t => t.dueDate && t.dueDate < nowStr);
    if (filtered.length === 0) {
      await sendWhatsAppMessage(sender, "✅ No overdue tasks!");
      return;
    }
    const sorted = sortTasksChronologically(filtered);
    let msgText = "⚠️ *Overdue Tasks:*\n\n";
    sorted.forEach((t, i) => { 
      const cleanTitle = cleanTaskTitle(t.text);
      const timeStr = t.dueDate ? ` ${formatFriendlyTime(t.dueDate, true)}` : '';
      msgText += `${i + 1}. ${cleanTitle}${timeStr}\n`; 
    });
    await sendWhatsAppMessage(sender, msgText);
    return;
  }

  // 5. Natural Language Task Creation & Command Fallback
  const parsed = parseIncomingMessage(trimText);

  const explicitTaskTriggers = [
    'remind me', 'add task', 'add', 'todo', 'don\'t forget',
    'make sure to', 'i need to', 'i have to', 'remember to'
  ];

  const hasExplicitIntent = explicitTaskTriggers.some(trigger => lowerText.startsWith(trigger));

  if (parsed.isTask && parsed.taskText && (hasExplicitIntent || parsed.dueDate)) {
    const cleanTitle = cleanTaskTitle(parsed.taskText);
    const newTask: Task = {
      id: Date.now(),
      text: cleanTitle,
      dueDate: parsed.dueDate,
      reminded: false,
      recurring: parsed.recurring
    };

    userTasks.push(newTask);
    saveDatabase(db);

    const timeMsg = parsed.dueDate ? `\n⏰ Reminder set for: *${formatFriendlyTime(parsed.dueDate, true)}*` : '';
    const recMsg = parsed.recurring ? `\n🔄 Repeats: *${parsed.recurring}*` : '';
    await sendWhatsAppMessage(sender, `✅ Task added: "${cleanTitle}"${timeMsg}${recMsg}`);
    return;
  }

  // Fallback for unrecognized commands or misheard voice notes
  await sendWhatsAppButtons(
    sender,
    `❌ Unrecognized command: *"${trimText}"*\n\nDid you mean to view your tasks, or create a new reminder?`,
    [
      { id: 'btn_go_to_menu', title: '📋 View Menu' }
    ]
  );
});

// --- Scheduled Cron Job with Single Ping & Interactive Snooze Buttons ---
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const formattedNow = formatDate(now);

  for (const sender in db) {
    for (const task of db[sender].tasks) {
      if (task.dueDate && task.dueDate <= formattedNow && !task.reminded) {
        try {
          const recurringNote = task.recurring ? ` _(Recurring: ${task.recurring})_` : '';
          const cleanTitle = cleanTaskTitle(task.text);

          await sendWhatsAppButtons(
            sender,
            `⏰ *NUDGE REMINDER*\n\n📌 "${cleanTitle}" is due now!${recurringNote}\n\nNeed more time? Tap a snooze button below or reply "done".`,
            [
              { id: `snz_15m_${task.id}`, title: '⏱️ 15 Mins' },
              { id: `snz_1h_${task.id}`, title: '⏰ 1 Hour' },
              { id: `snz_tom_${task.id}`, title: '🚀 Tomorrow' }
            ]
          );

          if (task.recurring) {
            task.dueDate = computeNextRecurrence(task.dueDate, task.recurring);
            task.reminded = false;
          } else {
            task.reminded = true;
          }

          saveDatabase(db);
        } catch (err) {
          console.error('Error sending scheduled reminder:', err);
        }
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Nudge Cloud API Server listening on port ${PORT}`);
});