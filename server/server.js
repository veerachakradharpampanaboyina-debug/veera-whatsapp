const fs = require('fs');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const mime = require('mime-types');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from public directory
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Global variables
let qrCodeData = null;
let userInfo = null;
let isAuthenticated = false;
let isInitializing = false;
let client = null;
let chats = [];
let contacts = [];
let isFetchingChats = false;
let isFetchingContacts = false;
let activeChats = new Map();
let messageQueue = new Map();
let typingUsers = new Map();
let connectionState = 'disconnected';

// Message status tracking
const messageStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed'
};

// Wait for client to be fully ready
async function waitForClientReady(timeout = 30000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (client && client.pupPage) {
      try {
        const isReady = await client.pupPage.evaluate(() => {
          return typeof window.Store !== 'undefined' && 
                 typeof window.Store.Chat !== 'undefined' &&
                 typeof window.Store.Contact !== 'undefined';
        });
        
        if (isReady) {
          return true;
        }
      } catch (error) {
        // Ignore evaluation errors and continue waiting
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error('Client not ready within timeout');
}

// Check client health
async function checkClientHealth() {
  if (!client || !client.pupPage) return false;
  
  try {
    const health = await client.pupPage.evaluate(() => {
      return {
        store: typeof window.Store !== 'undefined',
        chat: typeof window.Store?.Chat !== 'undefined',
        contact: typeof window.Store?.Contact !== 'undefined',
        msg: typeof window.Store?.Msg !== 'undefined'
      };
    });
    
    return health.store && health.chat && health.contact && health.msg;
  } catch (error) {
    return false;
  }
}

// Format message for client
async function formatMessage(message, chat) {
  try {
    const contact = await message.getContact();
    
    const formattedMessage = {
      id: message.id._serialized,
      body: message.body,
      type: message.type,
      timestamp: message.timestamp,
      from: message.from,
      fromMe: message.fromMe,
      to: message.to,
      hasMedia: message.hasMedia,
      caption: message.caption,
      isForwarded: message.isForwarded,
      isStatus: message.isStatus,
      chatId: chat.id._serialized,
      chatName: chat.name,
      senderName: contact.name || contact.pushname || contact.number,
      status: message.fromMe ? messageStatus.SENT : null
    };
    
    // If message has media, handle it
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        formattedMessage.media = {
          data: media.data,
          mimetype: media.mimetype,
          filename: `media_${message.id._serialized}.${mime.extension(media.mimetype) || 'bin'}`
        };
      } catch (error) {
        console.error('Error downloading media:', error);
        formattedMessage.mediaError = true;
      }
    }
    
    // Check if message is a reply
    if (message.hasQuotedMsg) {
      try {
        const quotedMsg = await message.getQuotedMessage();
        formattedMessage.quotedMessage = {
          id: quotedMsg.id._serialized,
          body: quotedMsg.body,
          from: quotedMsg.from,
          fromMe: quotedMsg.fromMe
        };
      } catch (error) {
        console.error('Error getting quoted message:', error);
      }
    }
    
    return formattedMessage;
  } catch (error) {
    console.error('Error formatting message:', error);
    // Return basic message info even if formatting fails
    return {
      id: message.id._serialized,
      body: message.body || 'Unable to load message',
      type: message.type,
      timestamp: message.timestamp,
      from: message.from,
      fromMe: message.fromMe,
      to: message.to,
      hasMedia: false,
      chatId: chat.id._serialized,
      chatName: chat.name,
      senderName: 'Unknown',
      status: message.fromMe ? messageStatus.SENT : null
    };
  }
}

// Update chat's last message
async function updateChatLastMessage(chatId, message) {
  const chatIndex = chats.findIndex(chat => chat.id === chatId);
  if (chatIndex !== -1) {
    chats[chatIndex].lastMessage = {
      body: message.body,
      timestamp: message.timestamp,
      fromMe: message.fromMe
    };
    chats[chatIndex].timestamp = message.timestamp;
    
    // Move chat to top
    const chat = chats.splice(chatIndex, 1)[0];
    chats.unshift(chat);
    
    io.emit('chats', chats);
  } else {
    // If chat not in list, refresh chats
    await fetchChats();
  }
}

// Fetch all chats with retry logic
async function fetchChats(maxRetries = 3, retryCount = 0) {
  if (!client || !isAuthenticated) {
    throw new Error('Client not authenticated');
  }
  
  if (isFetchingChats) {
    console.log('Chat fetch already in progress');
    return;
  }
  
  isFetchingChats = true;
  
  try {
    // Wait for client to be ready
    await waitForClientReady();
    
    let chatList;
    let retries = 0;
    const maxRetriesInternal = 3;
    
    while (retries < maxRetriesInternal) {
      try {
        chatList = await client.getChats();
        break;
      } catch (error) {
        retries++;
        if (retries === maxRetriesInternal) throw error;
        console.log(`Retrying getChats (${retries}/${maxRetriesInternal})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    }
    
    // Process all chats with error handling for each chat
    chats = [];
    for (const chat of chatList) {
      try {
        const contact = await chat.getContact();
        
        chats.push({
          id: chat.id._serialized,
          name: chat.name,
          isGroup: chat.isGroup,
          isReadOnly: chat.isReadOnly,
          unreadCount: chat.unreadCount,
          timestamp: chat.timestamp,
          lastMessage: chat.lastMessage ? {
            body: chat.lastMessage.body,
            timestamp: chat.lastMessage.timestamp,
            fromMe: chat.lastMessage.fromMe
          } : null,
          participants: chat.isGroup ? chat.participants.map(p => ({
            id: p.id._serialized,
            name: p.name || p.pushname || p.number
          })) : [],
          contact: {
            name: contact.name || contact.pushname || contact.number,
            number: contact.number,
            isBusiness: contact.isBusiness,
            isEnterprise: contact.isEnterprise
          }
        });
      } catch (error) {
        console.error('Error processing chat:', chat.id._serialized, error);
        // Add basic chat info even if contact fetch fails
        chats.push({
          id: chat.id._serialized,
          name: chat.name,
          isGroup: chat.isGroup,
          isReadOnly: chat.isReadOnly,
          unreadCount: chat.unreadCount,
          timestamp: chat.timestamp,
          lastMessage: chat.lastMessage ? {
            body: chat.lastMessage.body,
            timestamp: chat.lastMessage.timestamp,
            fromMe: chat.lastMessage.fromMe
          } : null,
          participants: chat.isGroup ? chat.participants.map(p => ({
            id: p.id._serialized,
            name: p.name || p.pushname || p.number
          })) : [],
          contact: {
            name: chat.name,
            number: chat.id.user,
            isBusiness: false,
            isEnterprise: false
          }
        });
      }
    }
    
    // Sort by timestamp (most recent first)
    chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    io.emit('chats', chats);
    io.emit('status', `Loaded ${chats.length} chats`);
    console.log(`Fetched ${chats.length} chats`);
    
  } catch (error) {
    console.error('Error fetching chats:', error);
    
    // Specific handling for the undefined error
    if (error.message.includes('Cannot read properties of undefined') && retryCount < maxRetries) {
      console.log('WhatsApp Web not fully loaded, retrying...');
      setTimeout(() => {
        fetchChats(maxRetries, retryCount + 1);
      }, 3000);
      return;
    }
    
    io.emit('error', 'Failed to fetch chats: ' + error.message);
  } finally {
    isFetchingChats = false;
  }
}

// Fetch contacts with retry logic
async function fetchContacts(maxRetries = 3, retryCount = 0) {
  if (!client || !isAuthenticated) {
    throw new Error('Client not authenticated');
  }
  
  if (isFetchingContacts) {
    console.log('Contacts fetch already in progress');
    return;
  }
  
  isFetchingContacts = true;
  
  try {
    // Wait for client to be ready
    await waitForClientReady();
    
    let contactList;
    let retries = 0;
    const maxRetriesInternal = 3;
    
    while (retries < maxRetriesInternal) {
      try {
        contactList = await client.getContacts();
        break;
      } catch (error) {
        retries++;
        if (retries === maxRetriesInternal) throw error;
        console.log(`Retrying getContacts (${retries}/${maxRetriesInternal})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    }
    
    contacts = [];
    for (const contact of contactList) {
      try {
        // Only include contacts with valid names/numbers
        if ((contact.name || contact.pushname || contact.number) && !contact.isMe) {
          contacts.push({
            id: contact.id._serialized,
            name: contact.name || contact.pushname || contact.number,
            number: contact.number,
            isBusiness: contact.isBusiness,
            isEnterprise: contact.isEnterprise,
            isMe: contact.isMe,
            isUser: contact.isUser,
            isWAContact: contact.isWAContact
          });
        }
      } catch (error) {
        console.error('Error processing contact:', contact.id._serialized, error);
      }
    }
    
    // Sort by name
    contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    io.emit('contacts', contacts);
    console.log(`Fetched ${contacts.length} contacts`);
    
  } catch (error) {
    console.error('Error fetching contacts:', error);
    
    // Specific handling for the undefined error
    if (error.message.includes('Cannot read properties of undefined') && retryCount < maxRetries) {
      console.log('WhatsApp Web not fully loaded, retrying...');
      setTimeout(() => {
        fetchContacts(maxRetries, retryCount + 1);
      }, 3000);
      return;
    }
    
    io.emit('error', 'Failed to fetch contacts: ' + error.message);
  } finally {
    isFetchingContacts = false;
  }
}

// Fetch messages for a specific chat with improved performance
async function fetchMessages(chatId, limit = 100, beforeId = null) {
  if (!client || !isAuthenticated) {
    throw new Error('Client not authenticated');
  }
  
  try {
    const chat = await client.getChatById(chatId);
    
    let messages;
    if (beforeId) {
      // Fetch messages before a specific message ID
      messages = await chat.fetchMessages({ limit, beforeId });
    } else {
      // Fetch latest messages
      messages = await chat.fetchMessages({ limit });
    }
    
    // Format messages
    const formattedMessages = [];
    for (const msg of messages) {
      try {
        const formattedMsg = await formatMessage(msg, chat);
        formattedMessages.push(formattedMsg);
      } catch (error) {
        console.error('Error formatting message:', msg.id._serialized, error);
      }
    }
    
    return formattedMessages;
  } catch (error) {
    console.error('Error fetching messages:', error);
    throw error;
  }
}

// Format phone number
function formatPhoneNumber(phoneNumber) {
  let cleaned = phoneNumber.replace(/\D/g, '');
  
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
  
  return `${cleaned}@c.us`;
}

// Check if a number exists on WhatsApp
async function checkNumberExists(number) {
  try {
    const formattedNumber = formatPhoneNumber(number);
    const exists = await client.isRegisteredUser(formattedNumber);
    return { exists, formattedNumber };
  } catch (error) {
    console.error('Error checking number:', error);
    throw error;
  }
}

// Send message with retry logic
async function sendMessageWithRetry(chatId, content, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const message = await client.sendMessage(chatId, content, options);
      return message;
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`Retry ${i + 1}/${retries} for sending message`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// Initialize WhatsApp client
function initializeWhatsAppClient(maxRetries = 5, retryCount = 0) {
  if (isInitializing && retryCount === 0) return;
  
  isInitializing = true;
  connectionState = 'connecting';
  
  // Clear previous client if exists
  if (client) {
    try {
      client.destroy();
    } catch (e) {
      console.error('Error destroying previous client:', e);
    }
  }

  // Create new client instance
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ],
      timeout: 60000
    },
    takeoverOnConflict: false,
    takeoverTimeoutMs: 0
  });

  // Generate QR code
  client.on('qr', async (qr) => {
    console.log('QR code received');
    try {
      qrCodeData = await QRCode.toDataURL(qr);
      io.emit('qr', qrCodeData);
      io.emit('status', 'QR code generated');
      retryCount = 0;
    } catch (err) {
      console.error('QR code generation error:', err);
      io.emit('error', 'Failed to generate QR code');
    }
  });

  // Save session
  client.on('authenticated', () => {
    console.log('Client authenticated');
    isAuthenticated = true;
    connectionState = 'authenticated';
    io.emit('status', 'Authenticated');
  });

  // Ready event
  client.on('ready', async () => {
    console.log('Client is ready');
    connectionState = 'ready';
    
    try {
      // Wait for internal components to be fully loaded
      await waitForClientReady();
      
      userInfo = client.info;
      io.emit('user', {
        number: userInfo.wid.user,
        name: userInfo.pushname,
        platform: userInfo.platform
      });
      io.emit('status', 'Ready');
      isInitializing = false;
      
      // Add a delay before fetching data
      setTimeout(async () => {
        try {
          await fetchChats();
        } catch (error) {
          console.error('Error fetching chats:', error);
        }
        
        try {
          await fetchContacts();
        } catch (error) {
          console.error('Error fetching contacts:', error);
        }
      }, 2000);
      
    } catch (error) {
      console.error('Error in ready handler:', error);
      io.emit('error', 'Client initialization failed: ' + error.message);
    }
  });

  // Handle incoming messages
  client.on('message', async (message) => {
    console.log('New message received:', message.body);
    
    try {
      const chat = await message.getChat();
      const formattedMessage = await formatMessage(message, chat);
      
      // Update chat last message
      await updateChatLastMessage(chat.id._serialized, formattedMessage);
      
      // Emit the new message
      io.emit('new-message', formattedMessage);
      
      // Send to specific socket if chat is active
      const socketId = activeChats.get(chat.id._serialized);
      if (socketId) {
        io.to(socketId).emit('active-chat-message', formattedMessage);
      }
    } catch (error) {
      console.error('Error processing incoming message:', error);
    }
  });

  // Handle message creation (for messages sent by yourself)
  client.on('message_create', async (message) => {
    if (message.fromMe) {
      console.log('Message sent:', message.body);
      
      try {
        const chat = await message.getChat();
        const formattedMessage = await formatMessage(message, chat);
        
        // Update message status in queue
        if (messageQueue.has(message.id._serialized)) {
          const queueItem = messageQueue.get(message.id._serialized);
          queueItem.status = messageStatus.SENT;
          messageQueue.set(message.id._serialized, queueItem);
          
          // Notify client
          io.to(queueItem.socketId).emit('message-status', {
            messageId: message.id._serialized,
            status: messageStatus.SENT
          });
        }
        
        // Update chat last message
        await updateChatLastMessage(chat.id._serialized, formattedMessage);
        
        // Emit the sent message
        io.emit('new-message', formattedMessage);
      } catch (error) {
        console.error('Error processing sent message:', error);
      }
    }
  });

  // Handle message status updates
  client.on('message_ack', async (message, ack) => {
    console.log('Message ACK received:', ack, 'for message:', message.id._serialized);
    
    let status;
    switch (ack) {
      case 1: status = messageStatus.SENT; break;
      case 2: status = messageStatus.DELIVERED; break;
      case 3: status = messageStatus.READ; break;
      default: status = messageStatus.SENT;
    }
    
    // Update message status in queue
    if (messageQueue.has(message.id._serialized)) {
      const queueItem = messageQueue.get(message.id._serialized);
      queueItem.status = status;
      messageQueue.set(message.id._serialized, queueItem);
      
      // Notify client
      io.to(queueItem.socketId).emit('message-status', {
        messageId: message.id._serialized,
        status: status
      });
    }
    
    // Update chat if needed
    if (status === messageStatus.READ) {
      try {
        await fetchChats();
      } catch (error) {
        console.error('Error updating chats after message read:', error);
      }
    }
  });

  // Handle authentication failure
  client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
    io.emit('error', 'Authentication failed. Please try again.');
    isAuthenticated = false;
    isInitializing = false;
    connectionState = 'auth_failed';
    
    // Retry after a delay
    if (retryCount < maxRetries) {
      setTimeout(() => {
        console.log(`Retrying authentication (${retryCount + 1}/${maxRetries})`);
        initializeWhatsAppClient(maxRetries, retryCount + 1);
      }, 5000);
    }
  });

  // Handle disconnects
  client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
    isAuthenticated = false;
    userInfo = null;
    isInitializing = false;
    connectionState = 'disconnected';
    chats = [];
    contacts = [];
    activeChats.clear();
    messageQueue.clear();
    typingUsers.clear();
    io.emit('status', 'Disconnected');
    io.emit('error', 'Disconnected from WhatsApp. Please scan the QR code again.');
    
    // Auto-reconnect after a delay
    setTimeout(() => {
      console.log('Attempting to reconnect...');
      initializeWhatsAppClient();
    }, 5000);
  });

  // Error handling
  client.on('error', (error) => {
    console.error('Client error:', error);
    
    if (error.message.includes('Execution context was destroyed') && retryCount < maxRetries) {
      console.log(`Execution context error detected, retrying (${retryCount + 1}/${maxRetries})`);
      io.emit('error', 'Connection issue detected. Retrying...');
      
      try {
        client.destroy();
      } catch (e) {
        console.error('Error destroying client on error:', e);
      }
      
      setTimeout(() => {
        initializeWhatsAppClient(maxRetries, retryCount + 1);
      }, 3000);
    } else {
      io.emit('error', 'An unexpected error occurred. Please try again.');
    }
  });

  // Initialize the client
  try {
    client.initialize().catch(err => {
      console.error('Initialization error:', err);
      if (retryCount < maxRetries) {
        setTimeout(() => {
          console.log(`Retrying initialization (${retryCount + 1}/${maxRetries})`);
          initializeWhatsAppClient(maxRetries, retryCount + 1);
        }, 3000);
      }
    });
  } catch (err) {
    console.error('Error initializing client:', err);
    if (retryCount < maxRetries) {
      setTimeout(() => {
        console.log(`Retrying initialization (${retryCount + 1}/${maxRetries})`);
        initializeWhatsAppClient(maxRetries, retryCount + 1);
      }, 3000);
    }
  }
}

// Periodic health check
setInterval(async () => {
  if (isAuthenticated) {
    const isHealthy = await checkClientHealth();
    if (!isHealthy && connectionState === 'ready') {
      console.log('Client unhealthy, attempting to reload...');
      io.emit('status', 'Reconnecting...');
      initializeWhatsAppClient();
    }
  }
}, 30000);

// Initialize WhatsApp client
initializeWhatsAppClient();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Send current status to newly connected client
  if (qrCodeData) {
    socket.emit('qr', qrCodeData);
  }
  
  if (userInfo) {
    socket.emit('user', {
      number: userInfo.wid.user,
      name: userInfo.pushname,
      platform: userInfo.platform
    });
    socket.emit('status', 'Ready');
  } else if (isInitializing) {
    socket.emit('status', 'Initializing...');
  } else {
    socket.emit('status', 'Not connected');
  }
  
  // Send existing data if available
  if (chats.length > 0) {
    socket.emit('chats', chats);
  }
  
  if (contacts.length > 0) {
    socket.emit('contacts', contacts);
  }
  
  // Handle retry requests
  socket.on('retry', () => {
    console.log('Retry requested');
    if (!isAuthenticated) {
      initializeWhatsAppClient();
    }
  });
  
  // Handle logout requests
  socket.on('logout', async () => {
    console.log('Logout requested');
    if (client) {
      try {
        await client.logout();
      } catch (error) {
        console.error('Error during logout:', error);
      }
    }
    userInfo = null;
    isAuthenticated = false;
    qrCodeData = null;
    chats = [];
    contacts = [];
    activeChats.clear();
    messageQueue.clear();
    typingUsers.clear();
    connectionState = 'disconnected';
    io.emit('status', 'Logged out');
    io.emit('user', null);
    io.emit('chats', []);
    io.emit('contacts', []);
  });
  
  // Handle fetch chats request
  socket.on('fetch-chats', async () => {
    console.log('Fetch chats requested');
    try {
      if (!client || !isAuthenticated) {
        throw new Error('Client not authenticated');
      }
      
      await fetchChats();
    } catch (error) {
      console.error('Failed to fetch chats:', error);
      socket.emit('error', 'Failed to fetch chats. Please try again in a moment.');
    }
  });
  
  // Handle fetch contacts request
  socket.on('fetch-contacts', async () => {
    console.log('Fetch contacts requested');
    try {
      if (!client || !isAuthenticated) {
        throw new Error('Client not authenticated');
      }
      
      await fetchContacts();
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
      socket.emit('error', 'Failed to fetch contacts. Please try again in a moment.');
    }
  });
  
  // Handle fetch messages request with pagination
  socket.on('fetch-messages', async (data) => {
    console.log('Fetch messages requested for chat:', data.chatId);
    try {
      if (!client || !isAuthenticated) {
        throw new Error('Client not authenticated');
      }
      
      const messages = await fetchMessages(
        data.chatId, 
        data.limit || 100, 
        data.beforeId || null
      );
      
      socket.emit('messages', {
        chatId: data.chatId,
        messages: messages,
        hasMore: messages.length === (data.limit || 100)
      });
    } catch (error) {
      console.error('Error fetching messages:', error);
      socket.emit('error', 'Failed to fetch messages: ' + error.message);
    }
  });
  
  // Handle open chat request
  socket.on('open-chat', async (chatId) => {
    console.log('Open chat requested:', chatId);
    
    if (!chatId) {
      socket.emit('error', 'Chat ID is required');
      return;
    }
    
    try {
      if (!client || !isAuthenticated) {
        throw new Error('Client not authenticated');
      }
      
      const chat = await client.getChatById(chatId);
      const messages = await fetchMessages(chatId, 100);
      
      // Mark as read if there are unread messages
      if (chat.unreadCount > 0) {
        await chat.sendSeen();
        await fetchChats(); // Refresh chats to update unread count
      }
      
      // Add to active chats
      activeChats.set(chatId, socket.id);
      
      socket.emit('chat-opened', {
        chatId: chat.id._serialized,
        chatName: chat.name,
        isGroup: chat.isGroup,
        messages: messages,
        unreadCount: chat.unreadCount
      });
      
    } catch (error) {
      console.error('Error opening chat:', error);
      socket.emit('error', 'Failed to open chat: ' + error.message);
    }
  });
  
  // Handle close chat request
  socket.on('close-chat', (chatId) => {
    console.log('Close chat requested:', chatId);
    activeChats.delete(chatId);
    socket.emit('chat-closed', { chatId });
  });
  
  // Handle check number request
  socket.on('check-number', async (phoneNumber) => {
    console.log('Check number requested:', phoneNumber);
    
    if (!phoneNumber || phoneNumber.trim() === '') {
      socket.emit('number-check-result', { exists: false, error: 'Phone number is required' });
      return;
    }
    
    try {
      if (!client || !isAuthenticated) {
        throw new Error('Client not authenticated');
      }
      
      const result = await checkNumberExists(phoneNumber);
      socket.emit('number-check-result', result);
    } catch (error) {
      console.error('Error checking number:', error);
      socket.emit('number-check-result', { 
        exists: false, 
        error: 'Failed to check number: ' + error.message 
      });
    }
  });
  
  // Handle start new chat request
  socket.on('start-new-chat', async (data) => {
    console.log('Start new chat requested with:', data.phoneNumber);
    
    if (!data.phoneNumber || data.phoneNumber.trim() === '') {
      socket.emit('error', 'Phone number is required to start a new chat');
      return;
    }
    
    try {
      if (!client || !isAuthenticated) {
        throw new Error('Client not authenticated');
      }
      
      const { exists, formattedNumber } = await checkNumberExists(data.phoneNumber);
      
      if (!exists) {
        socket.emit('error', 'This phone number is not registered on WhatsApp');
        return;
      }
      
      let chat;
      try {
        chat = await client.getChatById(formattedNumber);
      } catch (error) {
        // Chat doesn't exist, create a new one by sending a message
        if (data.initialMessage) {
          await client.sendMessage(formattedNumber, data.initialMessage);
          chat = await client.getChatById(formattedNumber);
        } else {
          await client.sendMessage(formattedNumber, '👋');
          chat = await client.getChatById(formattedNumber);
        }
      }
      
      const messages = await fetchMessages(chat.id._serialized, 100);
      activeChats.set(chat.id._serialized, socket.id);
      
      socket.emit('chat-started', {
        chatId: chat.id._serialized,
        chatName: chat.name,
        messages: messages,
        isNew: true
      });
      
      await fetchChats();
      
    } catch (error) {
      console.error('Error starting new chat:', error);
      socket.emit('error', 'Failed to start new chat: ' + error.message);
    }
  });
  
  // Handle send message request
  socket.on('send-message', async (data) => {
    console.log('Send message requested to:', data.chatId);
    
    if (!data.message || data.message.trim() === '') {
      socket.emit('error', 'Message cannot be empty');
      return;
    }
    
    try {
      if (!client || !isAuthenticated) {
        throw new Error('Client not authenticated');
      }
      
      let chatId = data.chatId;
      if (!chatId.endsWith('@c.us') && !chatId.endsWith('@g.us')) {
        chatId = `${chatId}@c.us`;
      }
      
      // Add to message queue with pending status
      const tempMessageId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      messageQueue.set(tempMessageId, {
        socketId: socket.id,
        status: messageStatus.PENDING,
        timestamp: Date.now()
      });
      
      // Send the message with retry logic
      const sentMessage = await sendMessageWithRetry(chatId, data.message.trim(), {
        quotedMessageId: data.replyTo || null
      });
      
      // Update message queue with actual ID
      messageQueue.delete(tempMessageId);
      messageQueue.set(sentMessage.id._serialized, {
        socketId: socket.id,
        status: messageStatus.SENT,
        timestamp: Date.now()
      });
      
      socket.emit('message-sent', {
        chatId: data.chatId,
        messageId: sentMessage.id._serialized,
        tempMessageId: tempMessageId
      });
      
      await fetchChats();
    } catch (error) {
      console.error('Error sending message:', error);
      
      // Update message status to failed
      if (data.tempMessageId && messageQueue.has(data.tempMessageId)) {
        const queueItem = messageQueue.get(data.tempMessageId);
        queueItem.status = messageStatus.FAILED;
        messageQueue.set(data.tempMessageId, queueItem);
        
        socket.emit('message-status', {
          messageId: data.tempMessageId,
          status: messageStatus.FAILED,
          error: error.message
        });
      }
      
      socket.emit('error', 'Failed to send message: ' + error.message);
    }
  });
  
  // Handle media message sending
  socket.on('send-media', async (data) => {
    console.log('Send media requested to:', data.chatId);
    
    if (!data.base64 || !data.mimetype) {
      socket.emit('error', 'Media data is required');
      return;
    }
    
    try {
      if (!client || !isAuthenticated) {
        throw new Error('Client not authenticated');
      }
      
      let chatId = data.chatId;
      if (!chatId.endsWith('@c.us') && !chatId.endsWith('@g.us')) {
        chatId = `${chatId}@c.us`;
      }
      
      const media = new MessageMedia(data.mimetype, data.base64, data.filename);
      
      // Add to message queue with pending status
      const tempMessageId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      messageQueue.set(tempMessageId, {
        socketId: socket.id,
        status: messageStatus.PENDING,
        timestamp: Date.now()
      });
      
      const sentMessage = await sendMessageWithRetry(chatId, media, {
        caption: data.caption || '',
        quotedMessageId: data.replyTo || null
      });
      
      // Update message queue with actual ID
      messageQueue.delete(tempMessageId);
      messageQueue.set(sentMessage.id._serialized, {
        socketId: socket.id,
        status: messageStatus.SENT,
        timestamp: Date.now()
      });
      
      socket.emit('message-sent', {
        chatId: data.chatId,
        messageId: sentMessage.id._serialized,
        tempMessageId: tempMessageId
      });
      
      await fetchChats();
    } catch (error) {
      console.error('Error sending media message:', error);
      
      // Update message status to failed
      if (data.tempMessageId && messageQueue.has(data.tempMessageId)) {
        const queueItem = messageQueue.get(data.tempMessageId);
        queueItem.status = messageStatus.FAILED;
        messageQueue.set(data.tempMessageId, queueItem);
        
        socket.emit('message-status', {
          messageId: data.tempMessageId,
          status: messageStatus.FAILED,
          error: error.message
        });
      }
      
      socket.emit('error', 'Failed to send media: ' + error.message);
    }
  });
  
  // Handle typing indicators
  socket.on('typing', async (data) => {
    try {
      if (!client || !isAuthenticated) return;
      
      const chatId = data.chatId;
      
      if (data.typing) {
        // Start showing typing indicator
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        
        // Store typing state
        typingUsers.set(socket.id, {
          chatId: chatId,
          timestamp: Date.now()
        });
      } else {
        // Stop showing typing indicator
        const chat = await client.getChatById(chatId);
        await chat.clearState();
        
        // Remove typing state
        typingUsers.delete(socket.id);
      }
    } catch (error) {
      console.error('Error with typing indicator:', error);
    }
  });
  
  // Handle marking chats as read
  socket.on('mark-as-read', async (chatId) => {
    try {
      if (!client || !isAuthenticated) return;
      
      const chat = await client.getChatById(chatId);
      await chat.sendSeen();
      await fetchChats();
    } catch (error) {
      console.error('Error marking chat as read:', error);
    }
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Clean up active chat sessions
    for (let [chatId, socketId] of activeChats.entries()) {
      if (socketId === socket.id) {
        activeChats.delete(chatId);
      }
    }
    
    // Clean up typing indicators
    if (typingUsers.has(socket.id)) {
      const typingData = typingUsers.get(socket.id);
      try {
        if (client && isAuthenticated) {
          client.getChatById(typingData.chatId)
            .then(chat => chat.clearState())
            .catch(err => console.error('Error clearing typing state on disconnect:', err));
        }
      } catch (error) {
        console.error('Error handling typing cleanup on disconnect:', error);
      }
      typingUsers.delete(socket.id);
    }
    
    // Clean up message queue
    for (let [messageId, queueItem] of messageQueue.entries()) {
      if (queueItem.socketId === socket.id) {
        messageQueue.delete(messageId);
      }
    }
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: connectionState,
    isAuthenticated,
    isInitializing,
    hasUserInfo: !!userInfo,
    chatCount: chats.length,
    contactCount: contacts.length,
    activeChats: activeChats.size,
    messageQueue: messageQueue.size,
    typingUsers: typingUsers.size
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully');
  if (client) {
    client.destroy();
  }
  server.close(() => {
    process.exit(0);
  });
});
