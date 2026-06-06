const express = require('express');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const Razorpay = require('razorpay');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key';
app.use(express.json());

// Helper function to run SQLite queries with Promises
function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                console.error("[DB ERROR] Failed to run query:", sql, params, err);
                reject(err);
            }
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

// Secure PIN generator for handovers
const generatePIN = () => Math.floor(100000 + Math.random() * 900000).toString();

// Automated SMS utility (Ready for Twilio/Nexmo integration)
const sendSMS = (to, message) => {
    console.log(`[SMS NOTIFICATION] To: ${to} | Message: ${message}`);
};

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}
app.use(cors());
app.use('/uploads', express.static('uploads'));

// --- Image Upload Configuration (Multer) ---
// Moved to top to ensure 'upload' is defined before being used in any route definitions
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, 'IMG-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Middleware to verify roles - Moved up to avoid ReferenceError
const authorize = (roles = []) => {
    return (req, res, next) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Unauthorized' });

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // Super-admin bypass: 'admin' role can access all role-restricted routes
            if (decoded.role === 'admin') {
                req.user = decoded;
                return next();
            }

            if (roles.length && !roles.includes(decoded.role)) {
                return res.status(403).json({ message: 'Forbidden' });
            }
            req.user = decoded;
            next();
        } catch (err) {
            res.status(401).json({ message: 'Invalid Token' });
        }
    };
};

// 1. Database Connection (SQLite)
const db = new sqlite3.Database('./manaVivekam.db', (err) => {
    if (err) {
        console.error('Could not connect to SQLite database', err);
    } else {
        console.log('Connected to SQLite database');
        // Enable foreign key constraints
        db.run("PRAGMA foreign_keys = ON;");

        db.serialize(() => {
            // 1. Create all tables sequentially inside serialize
            db.run(`CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                description TEXT,
                imageUrl TEXT,
                agentId INTEGER,
                status TEXT DEFAULT 'pending',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (agentId) REFERENCES users(id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS donations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orderId TEXT UNIQUE,
                paymentId TEXT,
                signature TEXT,
                amount INTEGER,
                currency TEXT,
                status TEXT DEFAULT 'pending',
                donorName TEXT,
                donorEmail TEXT,
                donorPhone TEXT,
                donorAddress TEXT,
                donorId INTEGER,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (donorId) REFERENCES users(id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                role TEXT CHECK(role IN ('admin', 'anadhasaranalayam', 'agent', 'hotel', 'donator')),
                displayName TEXT,
                location TEXT,
                childrenCount INTEGER DEFAULT 0,
                contactNumber TEXT,
                address TEXT,
                bio TEXT,
                profileImage TEXT,
                latitude REAL,
                longitude REAL,
                locationEnabled INTEGER DEFAULT 1,
                isOnline INTEGER DEFAULT 0
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS orphanage_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orphanageUserId INTEGER NOT NULL,
                item TEXT NOT NULL,
                quantity TEXT,
                servesCount INTEGER DEFAULT 0,
                description TEXT,
                address TEXT,
                isUrgent INTEGER DEFAULT 0,
                donorId INTEGER,
                numericQuantity REAL DEFAULT 0,
                remainingNumericQuantity REAL DEFAULT 0,
                unit TEXT DEFAULT 'units',
                status TEXT DEFAULT 'pending',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (orphanageUserId) REFERENCES users(id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS food_donations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                donorId INTEGER,
                foodItem TEXT,
                quantity TEXT,
                servesCount INTEGER DEFAULT 0,
                address TEXT,
                agentId INTEGER,
                orphanageRequestId INTEGER,
                status TEXT DEFAULT 'available',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (donorId) REFERENCES users(id),
                FOREIGN KEY (agentId) REFERENCES users(id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS community_alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT,
                description TEXT,
                contact TEXT,
                photo TEXT,
                date TEXT,
                status TEXT DEFAULT 'pending',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP
            )`);
            // 3. New Table Creation (Example: audit_logs)
            db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT,
                userId INTEGER,
                details TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP
            )`);

            // 4. Robust Migration Logic: Refactored to be sequential and wait for completion
            const addColumnIfMissing = (table, column, type) => {
                return new Promise((resolve) => {
                    db.all(`PRAGMA table_info(${table})`, (err, cols) => {
                        if (err) {
                            console.error(`Schema check failed for ${table}:`, err.message);
                            return resolve();
                        }
                        if (cols && !cols.some(c => c.name === column)) {
                            db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (err) => {
                                if (err) console.error(`Migration Failed: ALTER TABLE ${table} ADD COLUMN ${column} ${type} -`, err.message);
                                else console.log(`Migration Success: Added column '${column}' to table '${table}'`);
                                resolve();
                            });
                        } else {
                            resolve(); // Column already exists or table not found
                        }
                    });
                });
            };

            // Execute migrations and then seed data
            async function runMigrationsAndSeed() {
                await addColumnIfMissing('food_donations', 'agentId', 'INTEGER');
                await addColumnIfMissing('food_donations', 'donorId', 'INTEGER');
                await addColumnIfMissing('food_donations', 'deliveryImageUrl', 'TEXT');
                await addColumnIfMissing('food_donations', 'address', 'TEXT');
                await addColumnIfMissing('food_donations', 'servesCount', 'INTEGER DEFAULT 0');
                await addColumnIfMissing('food_donations', 'numericQuantity', 'REAL DEFAULT 0');
                await addColumnIfMissing('food_donations', 'orphanageRequestId', 'INTEGER');
                await addColumnIfMissing('food_donations', 'verificationPIN', 'TEXT');
                await addColumnIfMissing('orphanage_requests', 'servesCount', 'INTEGER DEFAULT 0');
                await addColumnIfMissing('orphanage_requests', 'address', 'TEXT');
                await addColumnIfMissing('orphanage_requests', 'isUrgent', 'INTEGER DEFAULT 0');
                await addColumnIfMissing('orphanage_requests', 'numericQuantity', 'REAL DEFAULT 0');
                await addColumnIfMissing('orphanage_requests', 'remainingNumericQuantity', 'REAL DEFAULT 0');
                await addColumnIfMissing('orphanage_requests', 'unit', "TEXT DEFAULT 'units'");
                await addColumnIfMissing('reports', 'agentId', 'INTEGER');
                await addColumnIfMissing('reports', 'status', "TEXT DEFAULT 'pending'");
                await addColumnIfMissing('donations', 'donorId', 'INTEGER');
                await addColumnIfMissing('donations', 'donorName', 'TEXT');
                await addColumnIfMissing('donations', 'donorEmail', 'TEXT');
                await addColumnIfMissing('donations', 'donorPhone', 'TEXT');
                await addColumnIfMissing('donations', 'donorAddress', 'TEXT');
                await addColumnIfMissing('orphanage_requests', 'donorId', 'INTEGER');
                await addColumnIfMissing('orphanage_requests', 'thankYouNote', 'TEXT');
                
                // Fix the community_alerts columns
                await addColumnIfMissing('community_alerts', 'contact', "TEXT");
                await addColumnIfMissing('community_alerts', 'photo', "TEXT");
                await addColumnIfMissing('community_alerts', 'date', "TEXT");
                await addColumnIfMissing('community_alerts', 'status', "TEXT DEFAULT 'pending'");
                await addColumnIfMissing('community_alerts', 'createdAt', "TEXT");
                
                // Fix users table columns
                await addColumnIfMissing('users', 'displayName', "TEXT");
                await addColumnIfMissing('users', 'location', "TEXT");
                await addColumnIfMissing('users', 'contactNumber', "TEXT");
                await addColumnIfMissing('users', 'lastLogin', "TEXT");
                await addColumnIfMissing('users', 'status', "TEXT DEFAULT 'approved'");
                await addColumnIfMissing('users', 'childrenCount', "INTEGER DEFAULT 0");
                await addColumnIfMissing('users', 'profileImage', "TEXT");
                await addColumnIfMissing('users', 'address', "TEXT");
                await addColumnIfMissing('users', 'bio', "TEXT");
                await addColumnIfMissing('users', 'latitude', "REAL");
                await addColumnIfMissing('users', 'longitude', "REAL");
                await addColumnIfMissing('users', 'locationEnabled', "INTEGER DEFAULT 1");
                await addColumnIfMissing('users', 'isOnline', "INTEGER DEFAULT 0");

                // 2. Seed data safely AFTER migrations are complete
                const salt = bcrypt.genSaltSync(10);
                const usersToSeed = [
                    { user: 'admin', pass: 'admin123', role: 'admin', name: 'System Admin', lat: 15.9129, lon: 79.7400 },
                    { user: 'anadha1', pass: 'anadha123', role: 'anadhasaranalayam', name: 'Amma Maatru Seva Orphanage', loc: 'Guntur District, AP', count: 42, lat: 16.3067, lon: 80.4365 },
                    { user: 'anadha2', pass: 'anadha123', role: 'anadhasaranalayam', name: 'Vivekananda Children\'s Welfare Home', loc: 'Krishna District, AP', count: 35, lat: 16.5062, lon: 80.6480 },
                    { user: 'anadha3', pass: 'anadha123', role: 'anadhasaranalayam', name: 'Little Hearts Rescue Center', loc: 'Nellore, AP', count: 28, lat: 14.4426, lon: 79.9865 },
                    { user: 'anadha4', pass: 'anadha123', role: 'anadhasaranalayam', name: 'Shanti Niketan Children\'s Home', loc: 'Tirupati, AP', count: 50, lat: 13.6285, lon: 79.4192 },
                    { user: 'anadha5', pass: 'anadha123', role: 'anadhasaranalayam', name: 'Sneha Child Care Foundation', loc: 'Visakhapatnam, AP', count: 64, lat: 17.6868, lon: 83.2185 },
                    { user: 'agent1', pass: 'agent123', role: 'agent', name: 'Field Agent 1' },
                    { user: 'hotel1', pass: 'hotel123', role: 'hotel', name: 'Sunshine Hotel' },
                    { user: 'donor1', pass: 'donor123', role: 'donator', name: 'Regular Donor' }
                ];
                for (const u of usersToSeed) {
                    const hash = bcrypt.hashSync(u.pass, salt);
                    await runQuery(`INSERT OR IGNORE INTO users (username, password, role, displayName, location, childrenCount, address, bio, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                        [u.user, hash, u.role, u.name, u.loc || null, u.count || 0, u.addr || null, u.bio || null, u.lat || null, u.lon || null]);
                }

                db.get(`SELECT id FROM users WHERE username = 'anadha1'`, (err, row) => {
                    if (row) {
                        db.run(`INSERT OR IGNORE INTO orphanage_requests (orphanageUserId, item, quantity, description, status) VALUES (?, ?, ?, ?, ?)`,
                            [row.id, 'Rice Bags', '50 kg', 'Urgent need for daily meals.', 'pending']);
                    }
                });

                db.get(`SELECT id FROM users WHERE username = 'donor1'`, (err, row) => {
                    if (row) {
                        db.run(`INSERT OR IGNORE INTO donations (orderId, amount, currency, donorName, donorEmail, donorPhone, donorAddress, status, donorId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            ['order_sample_123', 5000, 'INR', 'Regular Donor', 'donor1@example.com', '9876543210', 'Main Street, Guntur', 'success', row.id]);
                    }
                });

                // 5. Seed sample community alerts only AFTER columns are guaranteed to exist
                const sampleAlerts = [
                    { type: 'food_scarcity', description: 'Urgent need for food near Guntur.', contact: 'Ravi, 9876543210', photo: null, status: 'pending', date: new Date().toLocaleString(), createdAt: new Date().toISOString() },
                    { type: 'child_in_need', description: 'Children found unattended near Vijayawada station.', contact: 'Police, 100', photo: null, status: 'pending', date: new Date().toLocaleString(), createdAt: new Date().toISOString() },
                    { type: 'other_distress', description: 'Elderly person needs assistance.', contact: 'Local Resident, 9988776655', photo: null, status: 'pending', date: new Date().toLocaleString(), createdAt: new Date().toISOString() }
                ];
                
                sampleAlerts.forEach(alert => {
                    db.run(`INSERT OR IGNORE INTO community_alerts (type, description, contact, photo, status, date, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [alert.type, alert.description, alert.contact, alert.photo, alert.status, alert.date, alert.createdAt]);
                });
            }

            runMigrationsAndSeed().catch(err => console.error("Migration/Seed Error:", err));
        });
    }
});

// Public: Fetch latest uploaded audit/photos
app.get('/api/reports', (req, res) => {
    db.all(`SELECT id, title, description, imageUrl, createdAt FROM reports ORDER BY createdAt DESC LIMIT 12`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Public Registration for Donors
app.post('/api/register', async (req, res) => {
    const { username, password, contactNumber, displayName } = req.body;
    const role = 'donator'; // Restricted to donor role for public registration

    if (!username || !password || !contactNumber) {
        return res.status(400).json({ message: 'Username, password, and phone number are required.' });
    }

    db.get(`SELECT id FROM users WHERE username = ?`, [username], async (err, row) => {
        if (err) return res.status(500).json({ message: err.message });
        if (row) return res.status(400).json({ message: 'Username already exists.' });

        try {
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync(password, salt);
            const finalDisplayName = displayName || username;
            const sql = `INSERT INTO users (username, password, role, displayName, contactNumber) VALUES (?, ?, ?, ?, ?)`;
            await runQuery(sql, [username, hash, role, finalDisplayName, contactNumber]);
            res.status(201).json({ message: 'Registration successful! Please login.' });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
});

// Public Registration for Orphanages (starts as 'pending')
app.post('/api/register/orphanage', async (req, res) => {
    const { username, password, contactNumber, displayName, location } = req.body;
    
    if (!username || !password || !contactNumber || !location) {
        return res.status(400).json({ message: 'Username, password, phone, and location are required.' });
    }
    const { address, bio } = req.body; // Extract address and bio for orphanage registration
    db.get(`SELECT id FROM users WHERE username = ?`, [username], async (err, row) => {
        if (err) return res.status(500).json({ message: err.message });
        if (row) return res.status(400).json({ message: 'Username already exists.' });

        try {
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync(password, salt);
            const finalDisplayName = displayName || username;
            const sql = `INSERT INTO users (username, password, role, displayName, contactNumber, location, status, address, bio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await runQuery(sql, [username, hash, 'anadhasaranalayam', finalDisplayName, contactNumber, location, 'pending', address || null, bio || null]);
            res.status(201).json({ message: 'Registration submitted! Awaiting admin approval.' });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
});

// Login Endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (err || !user) return res.status(401).json({ message: 'User not found' });

        const isValid = bcrypt.compareSync(password, user.password);
        if (!isValid) return res.status(401).json({ message: 'Invalid password' });

        if (user.status === 'pending') return res.status(403).json({ message: 'Your account is pending approval by an administrator.' });
        if (user.status === 'rejected') return res.status(403).json({ message: 'Your account access has been revoked.' });

        // Update last login timestamp
        const now = new Date().toISOString();
        db.run(`UPDATE users SET lastLogin = ?, isOnline = 1 WHERE id = ?`, [now, user.id]);

        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token, role: user.role });
    });
});

// ============================================================
// --- UNIFIED ADMIN APIs (Full Solve: Routes & Role View) ---
// ============================================================

app.get('/api/admin/donations', authorize(['admin']), (req, res) => {
    db.all(`SELECT * FROM donations ORDER BY createdAt DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

app.get('/api/admin/users', authorize(['admin']), (req, res) => {
    let { role } = req.query;
    
    // Map common role names to internal DB values for better compatibility with frontend requests
    const roleMapping = {
        'donors': 'donator',
        'donorrs': 'donator', // Handling your specific request typo
        'donor': 'donator',
        'donator': 'donator',
        'agents': 'agent',
        'agent': 'agent',
        'hotels': 'hotel',
        'hotel': 'hotel',
        'orphanages': 'anadhasaranalayam'
    };

    let sql = `SELECT u.id, u.username, COALESCE(u.displayName, u.username) as displayName, u.contactNumber, u.location, u.role, u.lastLogin, u.status, u.locationEnabled, u.isOnline,
               (SELECT COUNT(*) FROM food_donations f WHERE f.agentId = u.id AND f.status = 'completed') as completedCount
               FROM users u`;
               
    const params = [];

    const targetRole = role ? roleMapping[role.toLowerCase()] || role : null;

    if (targetRole) {
        sql += ` WHERE role = ?`;
        params.push(targetRole);
    }

    sql += ` ORDER BY id DESC`;

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

app.post('/api/admin/users', authorize(['admin']), async (req, res) => {
    const { username, password, role, displayName, location, contactNumber, status, address, bio, childrenCount } = req.body;
    if (!username || !password || !role) return res.status(400).json({ message: 'Username, password, and role are required.' });

    db.get(`SELECT id FROM users WHERE username = ?`, [username], async (err, row) => {
        if (err) return res.status(500).json({ message: err.message });
        if (row) return res.status(400).json({ message: 'Username already exists.' });

        try {
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync(password, salt);
            const sql = `INSERT INTO users (username, password, role, displayName, location, contactNumber, status, address, bio, childrenCount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await runQuery(sql, [username, hash, role, displayName, location, contactNumber, status || 'approved', address || null, bio || null, childrenCount || 0]);
            res.status(201).json({ message: 'User created successfully' });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
});

app.put('/api/admin/users/:id', authorize(['admin']), async (req, res) => {
    const { id } = req.params;
    const { username, password, role, displayName, location, contactNumber, status, bio, childrenCount, address } = req.body;
    if (!username || !role) return res.status(400).json({ message: 'Username and role are required.' });

    try {
        let sql = `UPDATE users SET username = ?, role = ?, displayName = ?, location = ?, contactNumber = ?, status = ?, bio = ?, childrenCount = ?, address = ?`;
        let params = [username, role, displayName, location, contactNumber, status, bio, childrenCount || 0, address];

        if (password) {
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync(password, salt);
            sql += `, password = ?`;
            params.push(hash);
        }

        sql += ` WHERE id = ?`;
        params.push(id);

        const result = await runQuery(sql, params);
        if (result.changes === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ message: 'User updated successfully' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.delete('/api/admin/users/:id', authorize(['admin']), async (req, res) => {
    try {
        const result = await runQuery(`DELETE FROM users WHERE id = ?`, [req.params.id]);
        if (result.changes === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ message: 'User deleted successfully' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/admin/food-donations', authorize(['admin']), (req, res) => {
    const sql = `SELECT f.*, COALESCE(u.displayName, u.username, 'Anonymous') as donorName 
                 FROM food_donations f LEFT JOIN users u ON f.donorId = u.id 
                 ORDER BY f.createdAt DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

app.get('/api/admin/requests', authorize(['admin']), (req, res) => {
    const sql = `SELECT r.*, COALESCE(u.displayName, u.username) as orphanageName 
                 FROM orphanage_requests r JOIN users u ON r.orphanageUserId = u.id 
                 ORDER BY r.isUrgent DESC, r.createdAt DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

app.get('/api/admin/reports', authorize(['admin']), (req, res) => {
    db.all(`SELECT * FROM reports ORDER BY createdAt DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

app.get('/api/admin/community-alerts', authorize(['admin']), (req, res) => {
    db.all(`SELECT * FROM community_alerts ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows || []);
    });
});

app.put('/api/admin/community-alerts/:id', authorize(['admin']), async (req, res) => {
    const { status } = req.body;
    const id = Number(req.params.id);
    if (!status) return res.status(400).json({ message: 'Status is required.' });
    try {
        await runQuery(`UPDATE community_alerts SET status = ? WHERE id = ?`, [status, id]);
        res.json({ message: 'Alert status updated' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.delete('/api/admin/community-alerts/:id', authorize(['admin']), async (req, res) => {
    const id = Number(req.params.id);
    try {
        await runQuery(`DELETE FROM community_alerts WHERE id = ?`, [id]);
        res.json({ message: 'Alert deleted' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/admin/seed-community-alerts', authorize(['admin']), async (req, res) => {
    console.log('Admin: Seeding community alerts...');
    try {
        db.get(`SELECT COUNT(*) as count FROM community_alerts`, async (err, row) => {
            if (err) return res.status(500).json({ message: err.message });
            if (row.count === 0) {
                const sampleAlerts = [
                    { type: 'food_scarcity', description: 'Urgent need for food near Guntur.', contact: 'Ravi, 9876543210', photo: null, status: 'pending', date: new Date().toLocaleString(), createdAt: new Date().toISOString() }
                ];
                for (const alert of sampleAlerts) {
                    await runQuery(`INSERT INTO community_alerts (type, description, contact, photo, status, date, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [alert.type, alert.description, alert.contact, alert.photo, alert.status, alert.date, alert.createdAt]);
                }
                return res.json({ message: 'Sample alerts seeded successfully.' });
            }
            res.json({ message: 'Table already has data.' });
        });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// Generic Delete for other types
app.delete('/api/admin/:type/:id', authorize(['admin']), async (req, res) => {
    const { type, id } = req.params;
    const tableMap = { 
        'donations': 'donations', 
        'requests': 'orphanage_requests', 
        'reports': 'reports' 
    };
    const table = tableMap[type];
    if (!table) return res.status(400).json({ message: 'Invalid type' });
    try {
        await runQuery(`DELETE FROM ${table} WHERE id = ?`, [Number(id)]);
        res.json({ message: `${type} record deleted` });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// Update status for generic types
app.put('/api/admin/:type/:id/status', authorize(['admin']), async (req, res) => {
    const { type, id } = req.params;
    const { status } = req.body;
    const tableMap = { 
        'donations': 'donations', 
        'requests': 'orphanage_requests', 
        'reports': 'reports',
        'users': 'users'
    };
    const table = tableMap[type];
    if (!table) return res.status(400).json({ message: 'Invalid type' });
    try {
        await runQuery(`UPDATE ${table} SET status = ? WHERE id = ?`, [status, Number(id)]);
        res.json({ message: 'Status updated successfully' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// --- END ADMIN APIs ---

// Create a new orphanage request
app.post('/api/orphanage/requests', authorize(['anadhasaranalayam']), async (req, res) => {
    const { item, quantity, description, servesCount, address, isUrgent, latitude, longitude, numericQuantity, unit } = req.body;
    const orphanageUserId = req.user.id;
    if (!item) return res.status(400).json({ message: 'Item name is required' });
    try {
        const isUrgentVal = (isUrgent === 'true' || isUrgent === 1 || isUrgent === true || isUrgent === 'on') ? 1 : 0;
        const status = 'pending'; // Users requested that admin must approve first even for urgent needs

        // Auto-update profile location if provided during an urgent request
        if (isUrgentVal && latitude && longitude) {
            await runQuery(`UPDATE users SET latitude = ?, longitude = ?, locationEnabled = 1 WHERE id = ?`, [latitude, longitude, orphanageUserId]);
        }

        const sql = `INSERT INTO orphanage_requests (orphanageUserId, item, quantity, description, servesCount, address, isUrgent, status, numericQuantity, remainingNumericQuantity, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await runQuery(sql, [orphanageUserId, item, quantity, description, servesCount || 0, address || null, isUrgentVal, status, numericQuantity || 0, numericQuantity || 0, unit || 'units']);
        res.status(201).json({ message: 'Request submitted successfully' });
    } catch (error) { // Consistent error response
        res.status(500).json({ message: error.message });
    }
});

app.delete('/api/orphanage/requests/:id', authorize(['anadhasaranalayam']), async (req, res) => {
    try {
        const result = await runQuery(`DELETE FROM orphanage_requests WHERE id = ? AND orphanageUserId = ? AND status = 'pending'`, [Number(req.params.id), req.user.id]);
        if (result.changes === 0) return res.status(400).json({ message: 'Only pending requests can be cancelled.' });
        res.json({ message: 'Request cancelled successfully.' });
    } catch (error) { res.status(500).json({ message: error.message }); } // Consistent error response
});

app.put('/api/orphanage/requests/:id/received', authorize(['anadhasaranalayam']), async (req, res) => {
    const { id } = req.params;
    const { thankYouNote } = req.body;
    const orphanageUserId = req.user.id;
    try {
        const sql = `UPDATE orphanage_requests SET status = 'received', thankYouNote = ? WHERE id = ? AND orphanageUserId = ? AND status != 'received'`;
        const result = await runQuery(sql, [thankYouNote || null, Number(id), orphanageUserId]);
        if (result.changes === 0) {
            return res.status(400).json({ message: 'Request not found, not approved, or already received.' });
        }
        res.json({ message: 'Request marked as received successfully.' });
    } catch (error) { // Consistent error response
        res.status(500).json({ message: error.message });
    }
});

// API to fetch requests for the logged-in orphanage
app.get('/api/orphanage/requests', authorize(['anadhasaranalayam']), (req, res) => {
    const orphanageUserId = req.user.id;
    const sql = `SELECT r.*, u.displayName as donorName, u.contactNumber as donorPhone 
                 FROM orphanage_requests r 
                 LEFT JOIN users u ON r.donorId = u.id 
                 WHERE r.orphanageUserId = ? 
                 ORDER BY r.isUrgent DESC, r.createdAt DESC`;
    db.all(sql, [orphanageUserId], (err, rows) => {
        if (err) {
            return res.status(500).json({ message: err.message }); // Consistent error response
        }
        res.json(rows);
    });
});

app.get('/api/food/my-donations', authorize(['hotel', 'donator']), (req, res) => {
    db.all(`SELECT * FROM food_donations WHERE donorId = ? ORDER BY createdAt DESC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

// --- Orphanage Profile & Stats ---
app.get('/api/orphanage/profile', authorize(['anadhasaranalayam']), (req, res) => {
    const userId = req.user.id;
    db.get(`SELECT id, username, displayName, location, childrenCount, contactNumber, address, bio, lastLogin, role, status, profileImage FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ message: err.message });
        if (!user) return res.status(404).json({ message: 'Orphanage profile not found' });
        res.json(user);
    });
});

app.put('/api/orphanage/profile', authorize(['anadhasaranalayam']), upload.single('profileImage'), async (req, res) => {
    const userId = req.user.id;
    const body = req.body;
    const profileImage = req.file ? `/uploads/${req.file.filename}` : undefined;

    try {
        // Check for username uniqueness if changed
        if (body.username) {
            const existing = await new Promise((resolve, reject) => {
                db.get(`SELECT id FROM users WHERE username = ? AND id != ?`, [body.username, userId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            if (existing) return res.status(400).json({ message: 'Username is already taken' });
        }

        let updates = [];
        let params = [];

        const fields = ['username', 'displayName', 'location', 'childrenCount', 'contactNumber', 'address', 'bio', 'status', 'latitude', 'longitude', 'locationEnabled', 'role'];

        fields.forEach(field => {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                if (field === 'locationEnabled') {
                    params.push((body[field] === 'true' || body[field] === 1 || body[field] === true) ? 1 : 0);
                } else if (field === 'latitude' || field === 'longitude') {
                    params.push(body[field] === '' ? null : parseFloat(body[field]));
                } else if (field === 'childrenCount') {
                    params.push(parseInt(body[field]) || 0);
                } else {
                    params.push(body[field]);
                }
            }
        });

        if (profileImage) {
            updates.push(`profileImage = ?`);
            params.push(profileImage);
        }

        if (body.password) {
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync(body.password, salt);
            updates.push(`password = ?`);
            params.push(hash);
        }

        if (updates.length === 0) return res.json({ message: 'No changes provided' });

        let sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
        params.push(userId);

        await runQuery(sql, params);
        res.json({ message: 'Profile updated successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/orphanage/stats', authorize(['anadhasaranalayam']), (req, res) => {
    const userId = req.user.id;
    const sql = `
        SELECT 
            COUNT(*) as totalRequests,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingRequests,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approvedRequests,
            SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as receivedRequests
        FROM orphanage_requests 
        WHERE orphanageUserId = ?
    `;
    db.get(sql, [userId], (err, row) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json({
            totalRequests: row?.totalRequests || 0,
            pendingRequests: row?.pendingRequests || 0,
            approvedRequests: row?.approvedRequests || 0,
            receivedRequests: row?.receivedRequests || 0
        });
    });
});

app.post('/api/food/pickup-complete/:id', authorize(['agent']), upload.single('image'), async (req, res) => {
    const { id } = req.params;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    if (!imageUrl) return res.status(400).json({ message: 'Pickup photo is required.' });

    try {
        // Transition from 'reached' (at donor) to 'at_agent' (broadcasting) or 'delivering' (assigned)
        const sql = `UPDATE food_donations SET status = CASE WHEN (orphanageRequestId IS NOT NULL OR targetOrphanageId IS NOT NULL) THEN 'delivering' ELSE 'at_agent' END, deliveryImageUrl = ? WHERE id = ? AND agentId = ? AND status = 'reached'`;
        const result = await runQuery(sql, [imageUrl, Number(id), req.user.id]);
        if (result.changes === 0) return res.status(400).json({ message: 'Must reach donor first.' });

        // NEW: Send SMS to orphanage if already assigned
        db.get(`
            SELECT f.verificationPIN, f.foodItem, agent.displayName as agentName,
                   COALESCE(uo_req.contactNumber, uo_tgt.contactNumber) as phone,
                   COALESCE(uo_req.displayName, uo_tgt.displayName) as orphaName
            FROM food_donations f
            JOIN users agent ON f.agentId = agent.id
            LEFT JOIN orphanage_requests r ON f.orphanageRequestId = r.id
            LEFT JOIN users uo_req ON r.orphanageUserId = uo_req.id
            LEFT JOIN users uo_tgt ON f.targetOrphanageId = uo_tgt.id
            WHERE f.id = ?`, [Number(id)], (err, row) => {
                if (row && row.phone) {
                    const msg = `Mana Vivekam: Hi ${row.orphaName}, agent ${row.agentName} has picked up your ${row.foodItem}. Your handover PIN is: ${row.verificationPIN}. Please provide this to the agent upon arrival.`;
                    sendSMS(row.phone, msg);
                }
            });

        res.json({ message: 'Food picked up! Ready for delivery.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/food/delivery-complete/:id', authorize(['agent']), async (req, res) => {
    const { id } = req.params;
    try {
        const sql = `UPDATE food_donations SET status = 'completed' WHERE id = ? AND agentId = ? AND (targetOrphanageId IS NOT NULL OR orphanageRequestId IS NOT NULL)`;
        await runQuery(sql, [Number(id), req.user.id]);
        res.json({ message: 'Delivery finished!' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// Orphanage claims an unassigned food donation from an agent
app.post('/api/orphanage/claim-offer/:id', authorize(['anadhasaranalayam']), async (req, res) => {
    const { id } = req.params;
    const orphanageId = req.user.id;
    const pin = generatePIN();
    try {
        const sql = `UPDATE food_donations SET targetOrphanageId = ?, status = 'delivering', verificationPIN = ? WHERE id = ? AND status = 'at_agent' AND targetOrphanageId IS NULL`;
        const result = await runQuery(sql, [orphanageId, pin, Number(id)]);
        if (result.changes === 0) return res.status(400).json({ message: 'Offer no longer available.' });

        // NEW: Notify the orphanage immediately via SMS since pickup already happened
        db.get(`
            SELECT f.foodItem, u.contactNumber, u.displayName as orphaName, agent.displayName as agentName
            FROM food_donations f
            JOIN users u ON f.targetOrphanageId = u.id
            JOIN users agent ON f.agentId = agent.id
            WHERE f.id = ?`, [Number(id)], (err, row) => {
                if (row && row.contactNumber) {
                    const msg = `Mana Vivekam: Your claim for ${row.foodItem} is confirmed! Agent ${row.agentName} is on the way. Your handover PIN is: ${pin}.`;
                    sendSMS(row.contactNumber, msg);
                }
            });

        res.json({ message: 'Offer accepted! Agent is notified of your location.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.get('/api/orphanage/incoming-offers', authorize(['anadhasaranalayam']), (req, res) => {
    const sql = `SELECT f.*, u.displayName as agentName, u.contactNumber as agentPhone 
                 FROM food_donations f JOIN users u ON f.agentId = u.id 
                 WHERE f.status = 'at_agent' AND f.targetOrphanageId IS NULL AND f.orphanageRequestId IS NULL`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

app.get('/api/agent/tasks', authorize(['agent']), (req, res) => {
    const sql = `
        SELECT f.*, 
               uD.displayName as donorName, uD.contactNumber as donorPhone,
               COALESCE(uO_req.displayName, uO_tgt.displayName) as orphanageName,
               COALESCE(uO_req.address, uO_tgt.address) as orphanageAddress,
               COALESCE(uO_req.contactNumber, uO_tgt.contactNumber) as orphanagePhone
        FROM food_donations f
        JOIN users uD ON f.donorId = uD.id
        LEFT JOIN orphanage_requests req ON f.orphanageRequestId = req.id
        LEFT JOIN users uO_req ON req.orphanageUserId = uO_req.id
        LEFT JOIN users uO_tgt ON f.targetOrphanageId = uO_tgt.id
        WHERE f.agentId = ? AND f.status IN ('claimed', 'reached', 'at_agent', 'delivering') 
        ORDER BY f.createdAt DESC`;
    db.all(sql, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

app.post('/api/food/reach/:id', authorize(['agent']), async (req, res) => {
    const { id } = req.params;
    try {
        const sql = `UPDATE food_donations SET status = 'reached' WHERE id = ? AND agentId = ? AND status = 'claimed'`;
        const result = await runQuery(sql, [Number(id), req.user.id]);
        if (result.changes === 0) {
            return res.status(400).json({ message: 'Could not update status to reached.' });
        }
        res.json({ message: 'Reached location' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Agent claims a food donation (available -> claimed)
console.log('ROUTE REGISTERED: POST /api/food/claim/:id');
app.post('/api/food/claim/:id', authorize(['agent']), async (req, res) => {
    const { id } = req.params;
    try {
        // Only allow claiming when the donation is currently available.
        const sql = `UPDATE food_donations SET status = 'claimed', agentId = ? WHERE id = ? AND status = 'available'`;
        const result = await runQuery(sql, [req.user.id, Number(id)]);

        if (result.changes === 0) {
            return res.status(400).json({ message: 'Donation not available to claim (already claimed/reached/completed or invalid id).' });
        }

        res.json({ message: 'Pickup claimed successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/agent/tasks', authorize(['agent']), (req, res) => {
    db.all(`SELECT * FROM food_donations WHERE agentId = ? AND status IN ('claimed', 'reached') ORDER BY createdAt DESC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows);
    });
});

// --- Food Donation APIs ---
app.post('/api/food/donate', authorize(['hotel', 'donator']), async (req, res) => {
    try {
        const { foodItem, quantity, address, servesCount } = req.body;
        const sql = `INSERT INTO food_donations (donorId, foodItem, quantity, address, servesCount) VALUES (?, ?, ?, ?, ?)`;
        await runQuery(sql, [req.user.id, foodItem, quantity, address, servesCount || 0]);
        res.status(201).json({ message: 'Food donation logged' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/food/donations', (req, res) => {
    const { lat, lon } = req.query;
    // If agent location is provided, sort by nearest pickup
    let sql = `SELECT * FROM food_donations WHERE status = 'available' ORDER BY createdAt DESC`;
    
    // Basic sorting logic: In a production app, use a proper Geospatial query.
    // For now, we return all available and let agents see the address.
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message }); // Consistent error response
        res.json(rows);
    });
});
// Protected Upload Route: Only Admin and Agents can upload images
app.post('/api/upload', authorize(['admin', 'agent']), upload.single('image'), async (req, res) => {
    try {
        const { title, description } = req.body;
        const agentId = req.user.id;
        const imageUrl = `/uploads/${req.file.filename}`;
        const sql = `INSERT INTO reports (title, description, imageUrl, agentId) VALUES (?, ?, ?, ?)`;
        const result = await runQuery(sql, [title, description, imageUrl, agentId]);
        res.status(201).json({ 
            message: 'Upload successful', 
            data: { id: result.id, title, description, imageUrl } 
        });
    } catch (error) { // Consistent error response
        res.status(500).json({ message: error.message });
    }
});

// POST a new alert (from report-need.html form)
app.post('/api/alerts', upload.single('image'), async (req, res) => {
    try {
        const { type, description, contactInfo } = req.body;
        if (!type || !description) {
            return res.status(400).json({ message: 'Type and Description are required' }); // Consistent error response
        }
        console.log(`[ALERT RECEIVED]: Type: ${type}, Description: ${description.substring(0, 50)}..., Contact: ${contactInfo || 'Anonymous'}`);
        const photo = req.file ? req.file.filename : null;
        const date = new Date().toLocaleString();
        const createdAt = new Date().toISOString();
        const sql = `INSERT INTO community_alerts (type, description, contact, photo, date, createdAt) VALUES (?, ?, ?, ?, ?, ?)`;
        await runQuery(sql, [type, description, contactInfo, photo, date, createdAt]);
        res.status(201).json({ message: 'Alert submitted successfully' });
    } catch (error) { // Consistent error response
        console.error('Submission error:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET approved/resolved alerts for public view
app.get('/api/alerts', (req, res) => {
    // Only return alerts that have been approved or resolved by admin for the community board
    db.all(`SELECT * FROM community_alerts WHERE status IN ('approved', 'resolved', 'Approved', 'Resolved') ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message }); // Consistent error response
        res.json(rows);
    });
});

// 3. Payment Integration (Razorpay)
const razorpay = new Razorpay({
    key_id: process.env.RAZOR_KEY_ID || 'YOUR_KEY_ID',
    key_secret: process.env.RAZOR_KEY_SECRET || 'YOUR_KEY_SECRET'
});

app.post('/api/donate', async (req, res) => {
    const { amount, donorName, donorEmail, donorPhone, donorAddress } = req.body;
    let donorId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
        try {
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            donorId = decoded.id;
        } catch (e) { /* Public donation - no user linked */ }
    }
    const options = {
        amount: (amount || 500) * 100, // amount in paise
        currency: "INR",
        receipt: "receipt_" + Date.now(),
    };
    try {
        const order = await razorpay.orders.create(options);
        
        const sql = `INSERT INTO donations (orderId, amount, currency, donorName, donorEmail, donorPhone, donorAddress, status, donorId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await runQuery(sql, [
            order.id, 
            amount || 500, 
            "INR", 
            donorName || 'Anonymous', 
            donorEmail || 'no-email@provided.com',
            donorPhone || '',
            donorAddress || '',
            'pending',
            donorId
        ]);
        
        res.json(order);
    } catch (error) { // Consistent error response
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    const secret = process.env.RAZOR_KEY_SECRET || 'YOUR_KEY_SECRET';
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const generated_signature = hmac.digest('hex');

    if (generated_signature === razorpay_signature) {
        // Update status to success in DB
        const sql = `UPDATE donations SET paymentId = ?, signature = ?, status = 'success' WHERE orderId = ?`;
        await runQuery(sql, [razorpay_payment_id, razorpay_signature, razorpay_order_id]);
        res.json({ status: 'success' });
    } else {
        res.status(400).json({ status: 'failure', message: 'Invalid signature' });
    }
});

// --- Donor Dashboard API ---
app.get('/api/donor/summary', authorize(['donator']), (req, res) => {
    const userId = req.user.id;
    const stats = { badges: [], streak: 0 };

    const streakSql = `
        SELECT DISTINCT strftime('%Y-%m', createdAt) as month 
        FROM (
            SELECT createdAt FROM donations WHERE donorId = ? AND status = 'success'
            UNION
            SELECT createdAt FROM food_donations WHERE donorId = ? AND status = 'completed'
            UNION
            SELECT createdAt FROM orphanage_requests WHERE donorId = ? AND status = 'received'
        ) 
        ORDER BY month DESC
    `;

    const badgeSql = `
        SELECT 
            (SELECT COUNT(*) FROM donations WHERE donorId = ? AND status = 'success') as finCount,
            (SELECT SUM(amount) FROM donations WHERE donorId = ? AND status = 'success') as finSum,
            (SELECT SUM(servesCount) FROM food_donations WHERE donorId = ? AND status = 'completed') as foodServes,
            (SELECT COUNT(*) FROM orphanage_requests WHERE donorId = ? AND status = 'received') as itemsCount
    `;

    db.get(badgeSql, [userId, userId, userId, userId], (err, badgeRow) => {
        if (err) return res.status(500).json({ message: err.message });
        
        const finCount = badgeRow?.finCount || 0;
        const finSum = badgeRow?.finSum || 0;
        const foodServes = badgeRow?.foodServes || 0;
        const itemsCount = badgeRow?.itemsCount || 0;

        // --- Achievement Logic ---
        if (finCount > 0 || itemsCount > 0 || foodServes > 0) {
            stats.badges.push({ name: 'Kind Heart', icon: 'fa-heart', color: 'text-rose-600', bg: 'bg-rose-50' });
        }
        if (finCount + itemsCount >= 5) {
            stats.badges.push({ name: 'Silver Supporter', icon: 'fa-award', color: 'text-stone-500', bg: 'bg-stone-100' });
        }
        if (finCount + itemsCount >= 10) {
            stats.badges.push({ name: 'Gold Guardian', icon: 'fa-crown', color: 'text-amber-600', bg: 'bg-amber-50' });
        }
        if (foodServes >= 100) {
            stats.badges.push({ name: 'Meal Hero', icon: 'fa-bowl-food', color: 'text-orange-600', bg: 'bg-orange-50' });
        }
        if (finSum >= 10000) {
            stats.badges.push({ name: 'Village Pillar', icon: 'fa-building-columns', color: 'text-indigo-600', bg: 'bg-indigo-50' });
        }

        stats.totalFinancial = finSum || 0;

        db.all(streakSql, [userId, userId, userId], (err, months) => {
            if (!err && months && months.length > 0) {
                const now = new Date();
                const currentMonth = now.toISOString().slice(0, 7);
                const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7);
                const monthList = months.map(m => m.month);

                // Streak is only active if user donated this month or last month
                if (monthList.includes(currentMonth) || monthList.includes(lastMonth)) {
                    let currentStreak = 1;
                    // Count consecutive months backwards from the most recent donation
                    for (let i = 0; i < monthList.length - 1; i++) {
                        const d1 = new Date(monthList[i] + "-01");
                        const d2 = new Date(monthList[i+1] + "-01");
                        const diff = (d1.getFullYear() - d2.getFullYear()) * 12 + (d1.getMonth() - d2.getMonth());
                        
                        if (diff === 1) currentStreak++;
                        else break;
                    }
                    stats.streak = currentStreak;
                }
            }

            // Add streak-based badges
            if (stats.streak >= 3) {
                stats.badges.push({ name: 'Loyal Soul', icon: 'fa-calendar-check', color: 'text-blue-600', bg: 'bg-blue-50' });
            }
            if (stats.streak >= 6) {
                stats.badges.push({ name: 'Community Pillar', icon: 'fa-gem', color: 'text-purple-600', bg: 'bg-purple-50' });
            }
            if (stats.streak >= 12) {
                stats.badges.push({ name: 'Giver Legend', icon: 'fa-fire', color: 'text-orange-600', bg: 'bg-orange-50' });
            }

            db.all(`SELECT * FROM donations WHERE donorId = ? ORDER BY createdAt DESC LIMIT 5`, [userId], (err, financial) => {
            stats.recentFinancial = financial || [];
            db.all(`SELECT * FROM food_donations WHERE donorId = ? ORDER BY createdAt DESC LIMIT 5`, [userId], (err, food) => {
                stats.recentFood = food || [];
                const acceptedSql = `SELECT r.*, u.displayName as orphanageName, u.contactNumber as orphanagePhone, u.location as orphanageArea 
                                     FROM orphanage_requests r JOIN users u ON r.orphanageUserId = u.id 
                                     WHERE r.donorId = ? ORDER BY r.createdAt DESC`;
                db.all(acceptedSql, [userId], (err, requests) => {
                    stats.acceptedRequests = requests || [];
                    res.json(stats);
                });
            });
            });
        });
    });
});

// API to fetch donor's own profile
app.get('/api/donor/profile', authorize(['donator']), (req, res) => {
    const userId = req.user.id;
    db.get(`SELECT id, username, displayName, contactNumber, address, bio, profileImage, latitude, longitude, locationEnabled FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ message: err.message });
        if (!user) return res.status(404).json({ message: 'Donor profile not found' });
        res.json(user);
    });
});

// API to update donor's own profile
app.put('/api/donor/profile', authorize(['donator']), upload.single('profileImage'), async (req, res) => {
    const userId = req.user.id;
    const body = req.body;
    const profileImage = req.file ? `/uploads/${req.file.filename}` : undefined;

    console.log(`[DONOR PROFILE UPDATE] User ID: ${userId}`);
    console.log(`[DONOR PROFILE UPDATE] Request Body:`, body);

    try {
        // Check for username uniqueness if changed
        if (body.username) {
            const existing = await new Promise((resolve, reject) => {
                db.get(`SELECT id FROM users WHERE username = ? AND id != ?`, [body.username, userId], (err, row) => {
                    if (err) reject(err);
                    if (err) {
                        console.error(`[DONOR PROFILE UPDATE] Username check DB error:`, err);
                        reject(err);
                    }
                    else resolve(row);
                });
            });
            if (existing) {
                console.warn(`[DONOR PROFILE UPDATE] Username '${body.username}' already taken by another user.`);
                return res.status(400).json({ message: 'Username is already taken' });
            }
        }

        let updates = [];
        let params = [];

        // Fields that can be updated directly from the request body
        const fields = ['displayName', 'contactNumber', 'address', 'bio', 'username', 'latitude', 'longitude', 'locationEnabled'];
        
        fields.forEach(field => {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                if (field === 'locationEnabled') {
                    params.push((body[field] === 'true' || body[field] === 1 || body[field] === true) ? 1 : 0);
                } else if (field === 'latitude' || field === 'longitude') {
                    params.push(body[field] === '' ? null : parseFloat(body[field]));
                } else {
                    params.push(body[field]);
                }
            }
        });

        if (profileImage) {
            updates.push(`profileImage = ?`);
            params.push(profileImage);
        }

        if (body.password) {
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync(body.password, salt);
            updates.push(`password = ?`);
            params.push(hash);
        }

        if (updates.length === 0) {
            console.log(`[DONOR PROFILE UPDATE] No changes provided for user ID: ${userId}`);
            return res.json({ message: 'No changes provided' });
        }

        let sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
        params.push(userId);

        console.log(`[DONOR PROFILE UPDATE] Executing SQL: ${sql} with params:`, params);
        await runQuery(sql, params);
        console.log(`[DONOR PROFILE UPDATE] Profile updated successfully for user ID: ${userId}`);
        res.json({ message: 'Profile updated successfully' });
    } catch (error) {
        console.error(`[DONOR PROFILE UPDATE] Internal Server Error for user ID: ${userId}`, error);
        res.status(500).json({ message: error.message });
    }
});


// API to fetch user's own settings
app.get('/api/user/settings', authorize(), (req, res) => {
    db.get(`SELECT locationEnabled FROM users WHERE id = ?`, [req.user.id], (err, row) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(row || { locationEnabled: 1 });
    });
});

// API to update user's own settings
app.put('/api/user/settings', authorize(), async (req, res) => {
    const { locationEnabled } = req.body;
    try {
        await runQuery(`UPDATE users SET locationEnabled = ? WHERE id = ?`, 
            [locationEnabled ? 1 : 0, req.user.id]);
        res.json({ message: 'Settings updated successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/user/presence', authorize(), async (req, res) => {
    const { status } = req.body;
    try {
        await runQuery(`UPDATE users SET isOnline = ? WHERE id = ?`, [status ? 1 : 0, req.user.id]);
        res.json({ message: 'Presence updated' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/user/location', authorize(), async (req, res) => {
    const { latitude, longitude } = req.body;
    if (latitude === undefined || longitude === undefined) return res.status(400).json({ message: 'Coordinates required' });
    try {
        await runQuery(`UPDATE users SET latitude = ?, longitude = ?, isOnline = 1, locationEnabled = 1 WHERE id = ?`, [latitude, longitude, req.user.id]);
        res.json({ message: 'Location updated' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// Public API for Donor Highlights on Index
app.get('/api/public/donors', (req, res) => {
    db.all(`SELECT donorName, amount, createdAt FROM donations WHERE status = 'success' ORDER BY createdAt DESC LIMIT 6`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message }); // Consistent error response
        res.json(rows);
    });
});

// Public API for Verified Agents Gallery (builds trust with donors)
app.get('/api/public/verified-agents', (req, res) => {
    const sql = `
        SELECT * FROM (
            SELECT u.id, COALESCE(u.displayName, u.username) as name, u.profileImage,
                   (SELECT COUNT(*) FROM food_donations f WHERE f.agentId = u.id AND f.status = 'completed') as completedCount
            FROM users u
            WHERE u.role = 'agent' AND u.status = 'approved'
        ) WHERE completedCount >= 10
        ORDER BY completedCount DESC
        LIMIT 8
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows || []);
    });
});

// Public API for Food Donor Leaderboard
app.get('/api/public/leaderboard', (req, res) => {
    const sql = `
        SELECT 
            u.id, 
            COALESCE(u.displayName, u.username) as name, 
            u.profileImage,
            u.role,
            COUNT(f.id) as donationsCount,
            SUM(f.servesCount) as totalMeals
        FROM users u
        JOIN food_donations f ON u.id = f.donorId
        WHERE f.status = 'completed'
        GROUP BY u.id
        ORDER BY totalMeals DESC
        LIMIT 15
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(rows || []);
    });
});

// GET: Fetch orphanages sorted by distance and urgency
app.get('/api/donor/nearby-orphanages', authorize(['donator', 'hotel']), (req, res) => {
    const { lat, lon, urgentOnly } = req.query;
    if (!lat || !lon) return res.status(400).json({ message: 'Coordinates required' });

    const sql = `
        SELECT 
            u.id, u.displayName, u.location, u.address, u.childrenCount, u.latitude, u.longitude, u.profileImage,
            (SELECT COUNT(*) FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.status = 'approved') as pendingRequests,
            (SELECT COUNT(*) FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0) as urgentRequestCount,
            (SELECT COALESCE(MAX(isUrgent), 0) FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0) as hasUrgentNeed,
            (SELECT id FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0 ORDER BY r.createdAt DESC LIMIT 1) as urgentRequestId,
            (SELECT item FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0 ORDER BY r.createdAt DESC LIMIT 1) as urgentItemCategory,
            (SELECT quantity FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0 ORDER BY r.createdAt DESC LIMIT 1) as urgentItemQty,
            (SELECT description FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0 ORDER BY r.createdAt DESC LIMIT 1) as urgentItemDesc,
            (SELECT numericQuantity FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0 ORDER BY r.createdAt DESC LIMIT 1) as numericQuantity,
            (SELECT remainingNumericQuantity FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0 ORDER BY r.createdAt DESC LIMIT 1) as remainingNumericQuantity,
            (SELECT unit FROM orphanage_requests r WHERE r.orphanageUserId = u.id AND r.isUrgent = 1 AND r.status = 'approved' AND r.remainingNumericQuantity > 0 ORDER BY r.createdAt DESC LIMIT 1) as unit
        FROM users u 
        WHERE u.role = 'anadhasaranalayam' AND u.status = 'approved' AND u.latitude IS NOT NULL AND u.locationEnabled = 1
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        
        const calculateDistance = (lat1, lon1, lat2, lon2) => {
            const R = 6371; // km
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
                      Math.sin(dLon/2) * Math.sin(dLon/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            return R * c;
        };

        let results = rows.map(o => ({
            id: o.id,
            name: o.displayName,
            location: o.location,
            childrenCount: o.childrenCount,
            profileImage: o.profileImage,
            latitude: o.latitude,
            longitude: o.longitude,
            pendingRequests: o.pendingRequests || 0,
            urgentRequestCount: o.urgentRequestCount || 0,
            hasUrgentNeed: !!(o.hasUrgentNeed),
            urgentItemCategory: o.urgentItemCategory,
            urgentItemQty: o.urgentItemQty,
            urgentItemDesc: o.urgentItemDesc,
            numericQuantity: o.numericQuantity,
            remainingNumericQuantity: o.remainingNumericQuantity,
            unit: o.unit,
            urgentRequestId: o.urgentRequestId,
            distance: calculateDistance(parseFloat(lat), parseFloat(lon), o.latitude, o.longitude)
        }));

        if (urgentOnly === 'true') {
            results = results.filter(o => o.hasUrgentNeed);
        }

        const sorted = results.sort((a, b) => {
            if (b.hasUrgentNeed !== a.hasUrgentNeed) return b.hasUrgentNeed ? 1 : -1;
            return a.distance - b.distance;
        });

        res.json(sorted);
    });
});

// Fetching Orphanages (Mock DB data)
app.get('/api/orphanages', (req, res) => {
    db.all(`SELECT displayName as name, location, childrenCount, id FROM users WHERE role = 'anadhasaranalayam' AND status = 'approved'`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message }); // Consistent error response
        res.json(rows);
    });
});

// Handle the root route explicitly to serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve static files (HTML, CSS, JS) from the project directory
// This is placed after API routes so APIs take priority
app.use(express.static(__dirname));

// Catch-all 404 logger
app.use((req, res) => {
    console.log(`404: ${req.method} ${req.url}`);
    res.status(404).json({ message: `Route not found: ${req.method} ${req.url}` }); // Consistent error response
});

// Global error handler for crashes
app.use((err, req, res, next) => {
    console.error('Global Server Error:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message }); // Consistent error response
});

// Graceful shutdown: Ensures the database connection is closed when the server stops
function gracefulShutdown() {
    console.log('\nShutting down gracefully...');
    db.close((err) => {
        if (err) console.error('Error closing database:', err.message);
        else console.log('Database connection closed.');
        process.exit(0);
    });
}

process.on('SIGINT', gracefulShutdown); // Triggered by Ctrl+C
process.on('SIGTERM', gracefulShutdown); // Triggered by process termination

const PORT = process.env.PORT || 5000; // Changed port to 5000
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});