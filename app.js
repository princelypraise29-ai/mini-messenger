require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '10mb' }));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.post('/api/upload', upload.single('media'), async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !req.file) {
      return res.status(400).json({ error: 'Missing file or token' });
    }

    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const mime = req.file.mimetype || '';
    const isAudio = mime.startsWith('audio/') || req.file.originalname.includes('voice');
    const isVideo = mime.startsWith('video/');
    const msgType = isAudio ? 'voice' : isVideo ? 'video' : 'image';

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'super-messenger',
          resource_type: isAudio || isVideo ? 'video' : 'image'
        },
        (err, uploaded) => (err ? reject(err) : resolve(uploaded))
      );
      stream.end(req.file.buffer);
    });

    const liteUrl = msgType === 'image'
      ? result.secure_url.replace('/upload/', '/upload/w_540,q_auto:good/')
      : result.secure_url;

    res.json({ url: result.secure_url, liteUrl, msgType });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

/* Fetch all users + rich profile metadata + latest visible direct message */
app.get('/api/users', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const emailPrefix = user.email.split('@')[0];
  await supabaseAdmin.from('users').upsert({
    id: user.id,
    email: user.email,
    username: `${emailPrefix}_${user.id.slice(0, 4)}`,
    display_name: user.user_metadata?.full_name || emailPrefix,
    avatar_url: user.user_metadata?.avatar_url || ''
  }, { onConflict: 'id' });

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('*');

  const userList = users || [];

  const { data: myMemberships } = await supabaseAdmin
    .from('conversation_members')
    .select('conversation_id, conversations!inner(type)')
    .eq('user_id', user.id)
    .eq('conversations.type', 'direct');

  const directConvoIds = (myMemberships || []).map((m) => m.conversation_id);
  const lastMsgByPeer = new Map();

  if (directConvoIds.length > 0) {
    const { data: peerMembers } = await supabaseAdmin
      .from('conversation_members')
      .select('conversation_id, user_id')
      .in('conversation_id', directConvoIds)
      .neq('user_id', user.id);

    const { data: recentMsgs } = await supabaseAdmin
      .from('messages')
      .select('id, conversation_id, sender_id, msg_type, content, status, deleted_for_everyone, created_at')
      .in('conversation_id', directConvoIds)
      .order('created_at', { ascending: false })
      .limit(300);

    const latestByConvo = new Map();
    for (const m of recentMsgs || []) {
      if (!latestByConvo.has(m.conversation_id)) {
        latestByConvo.set(m.conversation_id, m);
      }
    }

    for (const pm of peerMembers || []) {
      const msg = latestByConvo.get(pm.conversation_id);
      if (msg) {
        lastMsgByPeer.set(pm.user_id, msg);
      }
    }
  }

  const enriched = userList.map((u) => ({
    ...u,
    last_message: lastMsgByPeer.get(u.id) || null
  }));

  res.json(enriched);
});

/* Update current user's full profile (name, nickname, bio, description, quote, avatar, cover) */
app.patch('/api/profile', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const {
    display_name,
    nickname,
    bio,
    description,
    favorite_quote,
    avatar_url,
    cover_url
  } = req.body || {};

  const patch = {};
  if (typeof display_name === 'string') patch.display_name = display_name.trim().slice(0, 80);
  if (typeof nickname === 'string') patch.nickname = nickname.trim().slice(0, 60);
  if (typeof bio === 'string') patch.bio = bio.trim().slice(0, 180);
  if (typeof description === 'string') patch.description = description.trim().slice(0, 500);
  if (typeof favorite_quote === 'string') patch.favorite_quote = favorite_quote.trim().slice(0, 240);
  if (typeof avatar_url === 'string') patch.avatar_url = avatar_url;
  if (typeof cover_url === 'string') patch.cover_url = cover_url;

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(patch)
    .eq('id', user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  io.emit('profile:updated', data);
  res.json({ profile: data });
});

app.post('/api/chat/direct', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { targetUserId } = req.body;
  if (!token || !targetUserId) return res.status(400).json({ error: 'Missing data' });

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  let convoId = null;

  const { data: myConvos } = await supabaseAdmin
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', user.id);

  const myIds = (myConvos || []).map((c) => c.conversation_id);
  if (myIds.length > 0) {
    const { data: shared } = await supabaseAdmin
      .from('conversation_members')
      .select('conversation_id, conversations!inner(type)')
      .eq('user_id', targetUserId)
      .in('conversation_id', myIds)
      .eq('conversations.type', 'direct')
      .limit(1);

    if (shared && shared.length > 0) {
      convoId = shared[0].conversation_id;
    }
  }

  if (!convoId) {
    const { data: newConvo, error } = await supabaseAdmin
      .from('conversations')
      .insert({ type: 'direct', created_by: user.id })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    convoId = newConvo.id;

    await supabaseAdmin.from('conversation_members').insert([
      { conversation_id: convoId, user_id: user.id, role: 'admin' },
      { conversation_id: convoId, user_id: targetUserId, role: 'member' }
    ]);
  }

  io.in(`user:${user.id}`).socketsJoin(`convo:${convoId}`);
  io.in(`user:${targetUserId}`).socketsJoin(`convo:${convoId}`);

  const { data: messages } = await supabaseAdmin
    .from('messages')
    .select('*')
    .eq('conversation_id', convoId)
    .order('created_at', { ascending: true });

  res.json({ conversationId: convoId, messages: messages || [] });
});

const onlineUsers = new Map();

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return next(new Error('Invalid session'));

  socket.user = user;
  next();
});

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  socket.join(`user:${userId}`);

  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);
  await supabaseAdmin.from('users').update({ is_online: true }).eq('id', userId);
  io.emit('presence:update', { userId, isOnline: true });

  const { data: memberships } = await supabaseAdmin
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', userId);

  if (memberships) {
    memberships.forEach((m) => socket.join(`convo:${m.conversation_id}`));
  }

  socket.on('message:send', async (payload, ack) => {
    const { data, error } = await supabaseAdmin
      .from('messages')
      .upsert({
        client_msg_id: payload.clientMsgId,
        conversation_id: payload.conversationId,
        sender_id: userId,
        reply_to_id: payload.replyToId || null,
        msg_type: payload.msgType || 'text',
        content: payload.content || '',
        media_url: payload.mediaUrl || null,
        media_lite_url: payload.mediaLiteUrl || null,
        is_forwarded: payload.isForwarded || false,
        is_view_once: payload.isViewOnce || false,
        unlock_at: payload.unlockAt || null,
        status: 'sent'
      }, { onConflict: 'client_msg_id' })
      .select()
      .single();

    if (error) return ack?.({ error: error.message });

    io.to(`convo:${payload.conversationId}`).emit('message:new', data);
    ack?.({ success: true, message: data });
  });

  socket.on('message:edit', async ({ messageId, conversationId, newContent }) => {
    const { data } = await supabaseAdmin
      .from('messages')
      .update({ content: newContent, is_edited: true })
      .eq('id', messageId)
      .eq('sender_id', userId)
      .select()
      .single();

    if (data) io.to(`convo:${conversationId}`).emit('message:updated', data);
  });

  /* Delete message:
     - scope: 'only_me' | 'both' | 'sender_own_only'
     - A user can delete another user's message from their own end ('only_me') without affecting the other user.
     - For a user's own message:
         * 'both': deletes on both ends (and removes row/placeholder cleanly)
         * 'only_me': hides from current user's end only
         * 'sender_own_only': removes the sender's own copy while keeping the delivered copy on the recipient's end if desired
  */
  socket.on('message:delete', async ({ messageId, conversationId, scope = 'both' }) => {
    const { data: msg } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (!msg) return;

    const isOwner = msg.sender_id === userId;

    if (!isOwner || scope === 'only_me') {
      socket.emit('message:hidden_for_user', { messageId, conversationId, userId });
      return;
    }

    if (scope === 'sender_own_only') {
      socket.emit('message:hidden_for_user', { messageId, conversationId, userId });
      return;
    }

    await supabaseAdmin
      .from('messages')
      .delete()
      .eq('id', messageId)
      .eq('sender_id', userId);

    io.to(`convo:${conversationId}`).emit('message:removed_for_everyone', {
      messageId,
      conversationId
    });
  });

  socket.on('message:react', ({ messageId, conversationId, emoji }) => {
    io.to(`convo:${conversationId}`).emit('message:reacted', {
      messageId,
      conversationId,
      userId,
      emoji
    });
  });

  socket.on('message:pin_state', ({ conversationId, pinnedIds }) => {
    io.to(`convo:${conversationId}`).emit('message:pin_state', {
      conversationId,
      pinnedIds: Array.isArray(pinnedIds) ? pinnedIds : []
    });
  });

  socket.on('message:outside_seen', async ({ conversationId }) => {
    if (!conversationId) return;
    await supabaseAdmin
      .from('messages')
      .update({ status: 'outside_seen' })
      .eq('conversation_id', conversationId)
      .neq('sender_id', userId)
      .eq('status', 'sent');

    socket.to(`convo:${conversationId}`).emit('messages:outside_seen', {
      conversationId,
      seenBy: userId
    });
  });

  socket.on('message:seen', async ({ conversationId }) => {
    if (!conversationId) return;
    await supabaseAdmin
      .from('messages')
      .update({ status: 'seen' })
      .eq('conversation_id', conversationId)
      .neq('sender_id', userId)
      .neq('status', 'seen');

    socket.to(`convo:${conversationId}`).emit('messages:seen', {
      conversationId,
      seenBy: userId
    });
  });

  socket.on('activity', ({ conversationId, state, handsFreeActive }) => {
    socket.to(`convo:${conversationId}`).emit('activity', {
      conversationId,
      userId,
      state,
      handsFreeActive: !!handsFreeActive
    });
  });

  socket.on('haptic:tap', ({ conversationId, effect }) => {
    socket.to(`convo:${conversationId}`).emit('haptic:tap', { conversationId, fromUserId: userId, effect });
  });

  socket.on('disconnect', async () => {
    const userSockets = onlineUsers.get(userId);
    if (userSockets) {
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        onlineUsers.delete(userId);
        const lastSeen = new Date().toISOString();
        await supabaseAdmin.from('users').update({ is_online: false, last_seen: lastSeen }).eq('id', userId);
        io.emit('presence:update', { userId, isOnline: false, lastSeen });
      }
    }
  });
});

setInterval(async () => {
  await supabaseAdmin.from('statuses').delete().lt('expires_at', new Date().toISOString());
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Super Messenger server running on port ${PORT}`);
});