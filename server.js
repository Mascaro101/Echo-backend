const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { customAlphabet } = require('nanoid');
require('dotenv').config();

const userSocketMap = {};

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ['http://localhost:5173', 'https://chat-tuah-frontend.vercel.app'],
    methods: ['GET', 'POST'],
  },
});

app.use(cors({
  origin: ['http://localhost:5173', 'https://chat-tuah-frontend.vercel.app'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
}));
app.use(express.json());

const mongoUri = process.env.MONGO_URI;

mongoose.connect(mongoUri).then(() => {
  console.log('Connected to MongoDB');
}).catch((err) => {
  console.error('Error connecting to MongoDB', err);
});

const userSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  username: String,
  hashedPassword: String,
  friends: [String],
  publicIdentityKeyX25519: String,
  publicIdentityKeyEd25519: String,
  signedPreKey: String,
  signature: String,
});

const messageSchema = new mongoose.Schema({
  text: String,
  userId: String,
  targetUserId: String, 
  username: String,
  seenStatus: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const Message = mongoose.model('Message', messageSchema);
const User = mongoose.model('User', userSchema);

const authenticate = (socket, next) => {
  const token = socket.handshake.auth.token;
  console.log("Received Token:", token);

  if (!token) {
    console.warn('No token provided, allowing unauthenticated access for login/register');

    return next();
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {

    if (!err && decoded) {
      userSocketMap[decoded.id] = socket.id;
      console.log(`User ${decoded.username} is mapped to socket ${socket.id}`);
    }

    if (err) {
      console.error('Invalid token:', err);
      return next(new Error('Authentication error'));
    }
    socket.user = decoded;
    next();
  });
};

io.use(authenticate);

io.on('connection', (socket) => {
  console.log(`A user connected with socket ID: ${socket.id}`);

  const token = socket.handshake.auth.token;
  
  if (token) {
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (!err && decoded) {
        userSocketMap[decoded.id] = socket.id;
        console.log(`User ${decoded.username} (ID: ${decoded.id}) mapped to socket ${socket.id}`);
        console.log('Current userSocketMap:', userSocketMap);
      }
    });
  }

  socket.on('fetchUsername', async (userId, callback) => {
    console.log('Fetching username for user:', userId);
    try {
      const user = await User.findOne({ id: userId });
      if (user) {
        callback({ success: true, username: user.username });
      } else {
        callback({ success: false, error: 'User not found' });
      }
    } catch (error) {
      console.error('Error fetching username:', error);
      callback({ success: false, error: 'Internal server error' });
    }
  });

  socket.on('ready', async ({ userId, targetUserId }) => {
    console.log(`User ${userId} is opening chat with ${targetUserId}`);
    
    // Create a private room between userId and targetUserId
    const room = [userId, targetUserId].sort().join('_');
    socket.join(room);

    try {
        const messages = await Message.find({
            $or: [
                  { userId, targetUserId },
                  { userId: targetUserId, targetUserId: userId },
            ],
        }).sort({ createdAt: 1 }); 

        console.log(`Sending ${messages.length} messages to User ${userId} ↔ ${targetUserId}`);

        // Message is emitted to users in room and no one else
        io.to(room).emit('initChat', messages);
    } catch (err) {
        console.error('Error fetching messages:', err);
    }
});

// Get the SignedPreKey Array (PreyKey + Signature) for XEdDSA 
socket.on('getSignedPreKey', async ({ targetUserId }, callback) => {
  console.log(`🔍 Fetching SignedPreKey for user: ${targetUserId}`);
  try {
    const user = await User.findOne({ id: targetUserId });
    if (!user) {
      console.error('❌ User not found');
      return callback({ success: false, error: 'User not found' });
    }
    console.log('✅ Found PreKey:', user.signedPreKey);
    console.log('✅ Found Signature:', user.signature);
    
    // Return the SignedPreKey as an array [publicPreKey, signature]
    callback({ success: true, signedPreKey: user.signedPreKey, signature: user.signature });
  } catch (error) {
    console.error('❌ Error fetching SignedPreKey:', error);
    callback({ success: false, error: 'Internal server error' });
  }
});

// Get publicIdentityKey in Montgomery format
socket.on('getPublicIdentityKeyX25519', async ({ targetUserId }, callback) => {
  console.log(`🔍 Fetching PublicIdentityKeyX25519 for user: ${targetUserId}`);
  try {
    const user = await User.findOne({ id: targetUserId });
    if (!user) {
      console.error('❌ User not found');
      return callback({ success: false, error: 'User not found' });
    }
    console.log('✅ Found publicIdentityKeyX25519:', user.publicIdentityKeyX25519);
    callback({ success: true, publicIdentityKeyX25519: user.publicIdentityKeyX25519 });
  } catch (error) {
    console.error('❌ Error fetching publicIdentityKeyX25519:', error);
    callback({ success: false, error: 'Internal server error' });
  }
});

// Get publicIdentityKey in Edwards format
socket.on('getPublicIdentityKeyEd25519', async ({ targetUserId }, callback) => {
  console.log(`🔍 Fetching publicIdentityKeyEd25519 for user: ${targetUserId}`);
  try {
    const user = await User.findOne({ id: targetUserId });
    if (!user) {
      console.error('❌ User not found');
      return callback({ success: false, error: 'User not found' });
    }
    console.log('✅ Found publicIdentityKeyEd25519:', user.publicIdentityKeyEd25519);
    callback({ success: true, publicIdentityKeyEd25519: user.publicIdentityKeyEd25519 });
  } catch (error) {
    console.error('❌ Error fetching publicIdentityKeyEd25519:', error);
    callback({ success: false, error: 'Internal server error' });
  }
});


socket.on('disconnect', () => {
    console.log(`🔴User with socket ID ${socket.id} disconnected.🔴`);

    for (const userId in userSocketMap) {
      if (userSocketMap[userId] === socket.id) {
        delete userSocketMap[userId];
        break;
      }
    }
  });

  socket.on('register', async (data, callback) => {
    const { username, password, keyBundle } = data;
    const { publicIdentityKeyX25519, publicIdentityKeyEd25519, publicSignedPreKey } = keyBundle;
    const [signedPreKey, signature] = publicSignedPreKey;

    console.log('Received register:', data);
    console.log('Public Identity Key X25519:', publicIdentityKeyX25519);
    console.log('Public Identity Key Ed25519:', publicIdentityKeyEd25519);
  
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 5);
      const id = nanoid();
      const user = new User({ id, username, hashedPassword, 
        publicIdentityKeyX25519: publicIdentityKeyX25519, 
        publicIdentityKeyEd25519: publicIdentityKeyEd25519,
        signedPreKey: signedPreKey,
        signature: signature,});

      await user.save();
      console.log('User saved:', user);
      callback({ success: true });
    } catch (err) {
      console.error('Error saving user:', err);
      callback({ success: false });
    }
  });

  socket.on('messageSeen', async (data) => {
    const { userId, targetUserId } = data;
    console.log("Message from ", userId, " seen by ", targetUserId);
  
    try {
      // Log the query and update
      console.log('Updating messages with query:', { userId, targetUserId, seenStatus: false });
      console.log('Update operation:', { $set: { seenStatus: true } });
  
      const result = await Message.updateMany(
        { userId: targetUserId, targetUserId: userId, seenStatus: false },
        { $set: { seenStatus: true } }
      );
  
      console.log('Updated messages seenStatus:', result);

      const senderSocketId = userSocketMap[targetUserId];
      if (senderSocketId) {
        io.to(senderSocketId).emit('messageSeenUpdate', { userId, targetUserId });
        console.log(`Notified sender ${targetUserId} with socket id ${senderSocketId} about seen status update`);
      }

    } catch (err) {
      console.error('Error updating seenStatus:', err);
    }
  });

  socket.on('login', async (data, callback) => {
    const { username, password } = data;
    console.log('Received login:', data);

    try {
      const user = await User.findOne({ username });
      if (!user) {
        console.log('User not found');
        return callback({ success: false, error: 'Invalid username or password' });
      }
      const isMatch = await bcrypt.compare(password, user.hashedPassword);
      if (!isMatch) {
        console.log('Password mismatch');
        return callback({ success: false, error: 'Invalid username or password' });
      }
      console.log('Password match');

      const token = jwt.sign(
        { id: user.id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      console.log('Generated Token:', token);

      callback({ success: true, token });
    } catch (err) {
      console.error('Error during login:', err);
      callback({ success: false, error: 'Login failed' });
    }
  });
  


  socket.on('newMessage', async (data) => {
    console.log('Received Data:', data);

    const { text, userId, targetUserId, username } = data;

    if (!text || !userId || !targetUserId || !username) {
      console.error('Missing fields in message data:', { text, userId, targetUserId, username });
      return;
    }

    console.log('Saving message:', { text, userId, targetUserId, username });

    try {
      const message = new Message({ text, userId, targetUserId, username, seenStatus: false });
      await message.save();
      console.log('Message successfully saved:', message);

      socket.broadcast.emit('newMessage', message);

      // Emit the message to the target user
      const targetSocketId = userSocketMap[targetUserId];

      if (targetSocketId) {
      console.log(`Sending message notification to User ${targetUserId} at Socket ${targetSocketId}`);

      // Send notification directly to the user
      io.to(targetSocketId, userId).emit('notification', {
        messageData: message,
      });

      // Also send the actual message event
      io.to(targetSocketId).emit('newMessage', message);
    } else {
      console.warn(`User ${targetUserId} is not connected, message stored but no real-time notification sent.`);
    }
  } catch (err) {
    console.error('Error saving message:', err);
  }
});

  socket.on('searchUser', async (data, callback) => {
    const username = data.searchTerm;
    console.log("Data:", data);
    console.log('Search user:', username);

    try {
      const user = await User.findOne({ username });
      if (!user) {
        console.log('User not found');
        return callback({ success: false, error: 'User not found' });
      }
      console.log('Found user:', user);
      callback({ success: true, user: { id: user.id, username: user.username } });
    } catch (error) {
      console.error('Error searching for user:', error);
      callback({ success: false, error: 'Internal server error' });
    }
  });
});

server.listen(3001, () => {
  console.log('listening on *:3001');
});