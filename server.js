const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createdQris, cekStatus } = require('./payment');
const config = require('./config');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const usersFile = path.join(DATA_DIR, 'users.json');
const keysFile = path.join(DATA_DIR, 'keys.json');
const ordersFile = path.join(DATA_DIR, 'orders.json');

const loadData = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
const saveData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const verifyToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token.split(' ')[1], config.jwtSecret);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========== CLEAN URL ROUTING ==========
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard-buyer.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard-admin.html'));
    
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== PUBLIC JSON ACCESS ==========
app.get('/data_keys.json', (req, res) => {
    if (fs.existsSync(keysFile)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(fs.readFileSync(keysFile));
    } else {
        res.json([]);
    }
});

app.get('/data_users.json', (req, res) => {
    if (fs.existsSync(usersFile)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(fs.readFileSync(usersFile));
    } else {
        res.json([]);
    }
});

app.get('/data_orders.json', (req, res) => {
    if (fs.existsSync(ordersFile)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(fs.readFileSync(ordersFile));
    } else {
        res.json([]);
    }
});

// ========== API ROUTES ==========

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  const users = loadData(usersFile);
  
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Username sudah dipakai' });
  }
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email sudah dipakai' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now(),
    username,
    email,
    password: hashedPassword,
    role: 'buyer',
    created_at: new Date().toISOString()
  };
  users.push(newUser);
  saveData(usersFile, users);
  
  const token = jwt.sign({ id: newUser.id, username, role: 'buyer' }, config.jwtSecret);
  res.json({ success: true, token, user: { id: newUser.id, username, email, role: 'buyer' } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const users = loadData(usersFile);
  const user = users.find(u => u.username === username);
  
  if (!user) return res.status(400).json({ error: 'User tidak ditemukan' });
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Password salah' });
  
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwtSecret);
  res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
});

app.post('/api/create-order', verifyToken, async (req, res) => {
  const { amount } = req.body;
  const priceList = { 50000: 'Basic', 100000: 'Premium', 200000: 'Pro', 500000: 'Ultimate' };
  if (!priceList[amount]) return res.status(400).json({ error: 'Harga tidak valid' });
  
  const qrisData = await createdQris(amount, config.pakasir);
  if (!qrisData) return res.status(500).json({ error: 'Gagal membuat QRIS' });
  
  const order = {
    id: Date.now(),
    user_id: req.user.id,
    username: req.user.username,
    amount: amount,
    package: priceList[amount],
    order_id: qrisData.idtransaksi,
    status: 'pending',
    qr_string: qrisData.qr_string,
    qr_base64: qrisData.imageqris ? qrisData.imageqris.toString('base64') : null,
    expired_at: qrisData.expired_at,
    created_at: new Date().toISOString()
  };
  
  const orders = loadData(ordersFile);
  orders.push(order);
  saveData(ordersFile, orders);
  
  res.json({
    success: true,
    order: {
      id: order.id,
      order_id: order.order_id,
      amount: order.amount,
      package: order.package,
      qr_base64: order.qr_base64,
      expired_at: order.expired_at
    }
  });
});

app.post('/api/check-payment', verifyToken, async (req, res) => {
  const { order_id, amount } = req.body;
  const orders = loadData(ordersFile);
  const order = orders.find(o => o.order_id === order_id && o.user_id === req.user.id);
  
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (order.status === 'completed') {
    return res.json({ success: true, status: 'completed', key: order.generated_key });
  }
  
  const isPaid = await cekStatus(order_id, amount, config.pakasir);
  
  if (isPaid && order.status !== 'completed') {
    const newKey = 'KEY-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() + 30);
    
    const keys = loadData(keysFile);
    keys.push({
      key: newKey,
      buyer: order.username,
      user_id: order.user_id,
      expired: expiredDate.toISOString().split('T')[0],
      created: new Date().toISOString(),
      package: order.package
    });
    saveData(keysFile, keys);
    
    order.status = 'completed';
    order.generated_key = newKey;
    order.completed_at = new Date().toISOString();
    saveData(ordersFile, orders);
    
    return res.json({ success: true, status: 'completed', key: newKey });
  }
  
  res.json({ success: true, status: 'pending' });
});

app.get('/api/my-keys', verifyToken, (req, res) => {
  const keys = loadData(keysFile);
  const myKeys = keys.filter(k => k.user_id === req.user.id);
  res.json({ success: true, keys: myKeys });
});

app.get('/api/my-orders', verifyToken, (req, res) => {
  const orders = loadData(ordersFile);
  const myOrders = orders.filter(o => o.user_id === req.user.id).sort((a,b) => b.id - a.id);
  res.json({ success: true, orders: myOrders });
});

app.get('/api/me', verifyToken, (req, res) => {
  const users = loadData(usersFile);
  const user = users.find(u => u.id === req.user.id);
  res.json({ success: true, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
});

// ========== ADMIN API ==========

app.get('/api/admin/stats', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak' });
  const users = loadData(usersFile);
  const keys = loadData(keysFile);
  const orders = loadData(ordersFile);
  const completedOrders = orders.filter(o => o.status === 'completed');
  const totalRevenue = completedOrders.reduce((sum, o) => sum + o.amount, 0);
  
  res.json({
    success: true,
    stats: {
      totalUsers: users.length,
      totalKeys: keys.length,
      totalOrders: orders.length,
      completedOrders: completedOrders.length,
      totalRevenue: totalRevenue,
      activeKeys: keys.filter(k => new Date(k.expired) > new Date()).length
    }
  });
});

app.get('/api/admin/users', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak' });
  const users = loadData(usersFile);
  res.json({ success: true, users: users.map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role, created_at: u.created_at })) });
});

app.get('/api/admin/orders', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak' });
  const orders = loadData(ordersFile);
  res.json({ success: true, orders: orders.sort((a,b) => b.id - a.id) });
});

app.get('/api/admin/keys', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak' });
  const keys = loadData(keysFile);
  res.json({ success: true, keys });
});

app.post('/api/admin/create-key', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak' });
  const { buyer, user_id, expired } = req.body;
  const newKey = 'KEY-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const keys = loadData(keysFile);
  keys.push({
    key: newKey,
    buyer: buyer,
    user_id: user_id || null,
    expired: expired,
    created: new Date().toISOString(),
    package: 'Manual'
  });
  saveData(keysFile, keys);
  res.json({ success: true, key: newKey });
});

app.delete('/api/admin/delete-key/:key', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak' });
  let keys = loadData(keysFile);
  keys = keys.filter(k => k.key !== req.params.key);
  saveData(keysFile, keys);
  res.json({ success: true });
});

app.delete('/api/admin/delete-user/:id', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak' });
  let users = loadData(usersFile);
  users = users.filter(u => u.id != req.params.id);
  saveData(usersFile, users);
  res.json({ success: true });
});

// ========== CREATE ADMIN FIRST ==========
(async () => {
  const users = loadData(usersFile);
  const adminExists = users.find(u => u.role === 'admin');
  if (!adminExists) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    const admin = {
      id: 1,
      username: 'admin',
      email: 'admin@ramzz.com',
      password: hashedPassword,
      role: 'admin',
      created_at: new Date().toISOString()
    };
    users.push(admin);
    saveData(usersFile, users);
    console.log('✅ Admin created: username=admin, password=admin123');
  }
})();

app.listen(config.port, () => {
  console.log(`🚀 Server running at http://localhost:${config.port}`);
});