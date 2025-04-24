const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

process.env.NTBA_FIX_350 = true;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GOOGLE_AI_STUDIO_API = process.env.GOOGLE_AI_STUDIO_API;
const AI_NAME = process.env.AI_NAME || "gemini-2.0-flash";

if (!GOOGLE_AI_STUDIO_API) {
  throw new Error(
    "GOOGLE_AI_STUDIO_API environment variable is missing.\nGet your API key from: https://aistudio.google.com/app/apikey"
  );
}
if (!TELEGRAM_TOKEN) {
  throw new Error(
    "TELEGRAM_TOKEN environment variable is missing.\nCreate a bot and get your token from: https://t.me/botfather"
  );
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GOOGLE_AI_STUDIO_API);
const kubitdb = require("kubitdb");
const db = new kubitdb("data");

bot.setMyCommands([
  { command: 'newchat', description: 'Start a new chat' },
  { command: 'removelastmsg', description: 'Remove last message' },
  { command: 'resent', description: 'Resend last message' }
]);

const tempai = {};
const userLastMessageTime = {};
const userPendingMessage = {}; 

function getHistoryKey(userId) {
  return `history-${userId}`;
}


function isRateLimited(userId) {
  const now = Date.now();
  if (
    userLastMessageTime[userId] &&
    now - userLastMessageTime[userId] < 5000
  ) {
    return 5000 - (now - userLastMessageTime[userId]);
  }
  userLastMessageTime[userId] = now;
  return 0;
}


function markdownToHtml(text) {
  if (!text) return '';
  text = text.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  text = text.replace(/_([^_]+)_/g, '<i>$1</i>');
  return text;
}

async function safeReply(msg, text) {
  const MAX_LENGTH = 2000;
  if (!text) return;
  let i = 0;
  while (i < text.length) {
    const chunk = text.slice(i, i + MAX_LENGTH);
    try{
      await bot.sendMessage(msg.chat.id, markdownToHtml(chunk), { parse_mode: "HTML" });
    }catch(e){
      console.log(e)
    }
    i += MAX_LENGTH;
  }
}

async function initChat(userId) {
  const history = db.get(getHistoryKey(userId)) || [];
  const chat = await genAI.getGenerativeModel({ model: AI_NAME }).startChat({
    history,
    params: require("./Ai_Settings.json"),
  });
  tempai[userId] = { history, ai: chat };
}

function popLastMessages(arr, count = 2) {
  for (let i = 0; i < count; i++) arr.pop();
}

bot.on("message", async (msg) => {
  if (!msg.text) return;
  msg.reply = (text) => safeReply(msg, text);

  const userId = msg.from.id;
  const historyKey = getHistoryKey(userId);

  const waitTime = isRateLimited(userId);
  if (waitTime > 0) {
    if (!userPendingMessage[userId]) {
      userPendingMessage[userId] = { ...msg };
      setTimeout(() => {
        const pendingMsg = userPendingMessage[userId];
        if (pendingMsg) {
          delete userPendingMessage[userId];
          bot.emit("message", pendingMsg);
        }
      }, waitTime);
      msg.reply("You sent a message too fast. Your message will be sent automatically in 5 seconds. Just wait.");
    } else {
      msg.reply("Do not spam, your previous message is in the queue. Please wait.");
    }
    return;
  }

  try {
    if (msg.text === "/newchat") {
      db.set(historyKey, []);
      delete tempai[userId];
      return msg.reply("Chat reset.");
    }

    if (!tempai[userId]) {
      await initChat(userId);
    }

    const chat = tempai[userId];
    const channeldata = db.get(historyKey) || [];

    if (msg.text === "/removelastmsg") {
      if (chat.history.length >= 2 && channeldata.length >= 2) {
        popLastMessages(chat.history);
        popLastMessages(channeldata);
        db.set(historyKey, channeldata);
        return msg.reply("Last message removed.");
      } else {
        return msg.reply("No messages to remove.");
      }
    }

    if (msg.text === "/resent") {
      if (chat.history.length < 2 || channeldata.length < 2) {
        return msg.reply("No messages to resend.");
      }
      msg.text = chat.history[chat.history.length - 2]?.parts[0]?.text || "";
      popLastMessages(chat.history);
      popLastMessages(channeldata);
      db.set(historyKey, channeldata);
      if (chat.history.length < 1) return msg.reply("No messages to resend.");
      if (!msg.text) return msg.reply("No valid message to resend.");
    }

    const response = await (await chat.ai.sendMessage(msg.text)).response.text();

    db.push(historyKey, {
      role: "user",
      parts: [{ text: msg.text }]
    });
    db.push(historyKey, {
      role: "model",
      parts: [{ text: response }]
    });

    return msg.reply(response);
  } catch (err) {
    console.error("Error:", err);
    return msg.reply("An error occurred. Please try again or contact the admin.");
  }
});