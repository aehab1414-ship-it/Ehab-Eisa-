/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ود حنين - نظام إدارة المندوبين
 *  Wad Haneen - Courier Management System v4.0
 *  Backend Server (Node.js + Express + PostgreSQL)
 *  تحديث: دعم نينجا مطعم + نينجا بقالة + التقارير المالية
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"]
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-only-secret');
if (process.env.NODE_ENV === 'production' && (!JWT_SECRET || JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production.');
}
const JWT_EXPIRES = '24h';

// إعدادات الرواتب والطلبات
const DAILY_TARGET_ORDERS = 17; // الهدف اليومي
const MONTHLY_SALARY = 6500; // الراتب الشهري بالريال
const ORDER_VALUE = Math.round(MONTHLY_SALARY / (DAILY_TARGET_ORDERS * 30)); // قيمة الطلب الواحد
const BONUS_PER_ORDER = 12; // البونص لكل طلب فوق الهدف

// Database Configuration
const pool = new Pool(process.env.DATABASE_URL ? {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
} : {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'wad_haneen_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  ssl: false
});

// Email Configuration (SendGrid)
const transporter = nodemailer.createTransport({
  service: 'SendGrid',
  auth: {
    user: 'apikey',
    pass: process.env.SENDGRID_API_KEY
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL ? process.env.CLIENT_URL.split(',').map(v => v.trim()) : false, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.status(200).json({ status: 'ok', database: 'connected' }); }
  catch (_err) { res.status(503).json({ status: 'error', database: 'disconnected' }); }
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════
const initDatabase = async () => {
  try {
    // جدول المستخدمين
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(20) DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول المندوبين - محدث ليدعم نينجا مطعم ونينجا بقالة
    await pool.query(`
      CREATE TABLE IF NOT EXISTS couriers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(255),
        app_type VARCHAR(50) NOT NULL,
        app_user_id VARCHAR(100),
        status VARCHAR(20) DEFAULT 'offline',
        shift_start TIME,
        shift_end TIME,
        is_online BOOLEAN DEFAULT FALSE,
        last_seen TIMESTAMP,
        current_orders INTEGER DEFAULT 0,
        total_hours DECIMAL(10,2) DEFAULT 0,
        idle_count INTEGER DEFAULT 0,
        daily_target INTEGER DEFAULT 17,
        monthly_salary DECIMAL(10,2) DEFAULT 6500,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول الطلبات الجديد
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        courier_id INTEGER REFERENCES couriers(id) ON DELETE CASCADE,
        order_number VARCHAR(50) NOT NULL,
        app_type VARCHAR(50) NOT NULL,
        order_value DECIMAL(10,2) DEFAULT 0,
        delivery_fee DECIMAL(10,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'delivered',
        delivery_date DATE DEFAULT CURRENT_DATE,
        delivery_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        customer_name VARCHAR(100),
        customer_phone VARCHAR(20),
        location_lat DECIMAL(10,8),
        location_lng DECIMAL(11,8),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول سجل الطلبات اليومية
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_orders_summary (
        id SERIAL PRIMARY KEY,
        courier_id INTEGER REFERENCES couriers(id) ON DELETE CASCADE,
        app_type VARCHAR(50) NOT NULL,
        date DATE DEFAULT CURRENT_DATE,
        target_orders INTEGER DEFAULT 17,
        completed_orders INTEGER DEFAULT 0,
        remaining_orders INTEGER DEFAULT 17,
        order_value DECIMAL(10,2) DEFAULT 0,
        bonus_orders INTEGER DEFAULT 0,
        bonus_amount DECIMAL(10,2) DEFAULT 0,
        deductions DECIMAL(10,2) DEFAULT 0,
        daily_total DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(courier_id, app_type, date)
      )
    `);

    // جدول التقارير المالية الشهرية
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monthly_reports (
        id SERIAL PRIMARY KEY,
        courier_id INTEGER REFERENCES couriers(id) ON DELETE CASCADE,
        app_type VARCHAR(50) NOT NULL,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        total_orders INTEGER DEFAULT 0,
        target_orders INTEGER DEFAULT 0,
        completed_target INTEGER DEFAULT 0,
        missed_orders INTEGER DEFAULT 0,
        bonus_orders INTEGER DEFAULT 0,
        base_salary DECIMAL(10,2) DEFAULT 6500,
        bonus_amount DECIMAL(10,2) DEFAULT 0,
        deductions DECIMAL(10,2) DEFAULT 0,
        delivery_fees DECIMAL(10,2) DEFAULT 0,
        net_salary DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(courier_id, app_type, year, month)
      )
    `);

    // جدول التقارير الأسبوعية
    await pool.query(`
      CREATE TABLE IF NOT EXISTS weekly_reports (
        id SERIAL PRIMARY KEY,
        courier_id INTEGER REFERENCES couriers(id) ON DELETE CASCADE,
        app_type VARCHAR(50) NOT NULL,
        year INTEGER NOT NULL,
        week_number INTEGER NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        total_orders INTEGER DEFAULT 0,
        target_orders INTEGER DEFAULT 0,
        completed_target INTEGER DEFAULT 0,
        missed_orders INTEGER DEFAULT 0,
        bonus_orders INTEGER DEFAULT 0,
        bonus_amount DECIMAL(10,2) DEFAULT 0,
        deductions DECIMAL(10,2) DEFAULT 0,
        delivery_fees DECIMAL(10,2) DEFAULT 0,
        net_total DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(courier_id, app_type, year, week_number)
      )
    `);

    // جدول سجل النشاطات
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        courier_id INTEGER REFERENCES couriers(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        app_type VARCHAR(50),
        duration INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        location_lat DECIMAL(10,8),
        location_lng DECIMAL(11,8)
      )
    `);

    // جدول التنبيهات
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        courier_id INTEGER REFERENCES couriers(id) ON DELETE CASCADE,
        alert_type VARCHAR(50) NOT NULL,
        message TEXT,
        sent_email BOOLEAN DEFAULT FALSE,
        sent_sms BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول إعدادات التطبيقات
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_integrations (
        id SERIAL PRIMARY KEY,
        app_name VARCHAR(50) NOT NULL,
        app_type VARCHAR(50) NOT NULL,
        api_key VARCHAR(255),
        api_secret VARCHAR(255),
        webhook_url VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        last_sync TIMESTAMP
      )
    `);


    // Live location and shift-monitoring tables (location must be shared by the courier app with notice/consent)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS courier_locations (
        id BIGSERIAL PRIMARY KEY,
        courier_id INTEGER NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
        latitude DECIMAL(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
        longitude DECIMAL(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
        accuracy_m DECIMAL(10,2),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_courier_locations_latest ON courier_locations(courier_id, recorded_at DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shift_alert_dedup (
        id BIGSERIAL PRIMARY KEY,
        courier_id INTEGER NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
        alert_date DATE NOT NULL DEFAULT CURRENT_DATE,
        alert_type VARCHAR(40) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(courier_id, alert_date, alert_type)
      )
    `);

    // إنشاء حساب الإدارة الأول فقط من متغيرات البيئة، دون كلمة مرور ثابتة داخل الكود.
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await pool.query(`
        INSERT INTO users (email, password, name, role)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) DO NOTHING
      `, [process.env.ADMIN_EMAIL, hashedPassword, process.env.ADMIN_NAME || 'Administrator', 'admin']);
    } else if (process.env.NODE_ENV === 'production') {
      console.warn('ADMIN_EMAIL/ADMIN_PASSWORD not set; admin seed skipped. Set both in hosting environment.');
    }

    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - الحسابات المالية
// ═══════════════════════════════════════════════════════════════════════════════

// حساب قيمة الطلب الواحد
const calculateOrderValue = () => {
  return Math.round(MONTHLY_SALARY / (DAILY_TARGET_ORDERS * 30));
};

// حساب البونص
const calculateBonus = (completedOrders, targetOrders) => {
  const bonusOrders = Math.max(0, completedOrders - targetOrders);
  return {
    bonusOrders,
    bonusAmount: bonusOrders * BONUS_PER_ORDER
  };
};

// حساب الخصومات
const calculateDeductions = (completedOrders, targetOrders) => {
  const missedOrders = Math.max(0, targetOrders - completedOrders);
  const orderValue = calculateOrderValue();
  return {
    missedOrders,
    deductionAmount: missedOrders * orderValue
  };
};

// تحديث ملخص الطلبات اليومية
const updateDailySummary = async (courierId, appType, date) => {
  try {
    const orderValue = calculateOrderValue();

    // عدد الطلبات المكتملة اليوم
    const ordersResult = await pool.query(`
      SELECT COUNT(*) as completed_orders, COALESCE(SUM(delivery_fee), 0) as total_fees
      FROM orders 
      WHERE courier_id = $1 AND app_type = $2 AND delivery_date = $3 AND status = 'delivered'
    `, [courierId, appType, date]);

    const completedOrders = parseInt(ordersResult.rows[0].completed_orders);
    const totalFees = parseFloat(ordersResult.rows[0].total_fees);

    const { bonusOrders, bonusAmount } = calculateBonus(completedOrders, DAILY_TARGET_ORDERS);
    const { missedOrders, deductionAmount } = calculateDeductions(completedOrders, DAILY_TARGET_ORDERS);

    const remainingOrders = Math.max(0, DAILY_TARGET_ORDERS - completedOrders);
    const dailyTotal = totalFees + bonusAmount - deductionAmount;

    await pool.query(`
      INSERT INTO daily_orders_summary 
      (courier_id, app_type, date, target_orders, completed_orders, remaining_orders, 
       order_value, bonus_orders, bonus_amount, deductions, daily_total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (courier_id, app_type, date) 
      DO UPDATE SET 
        completed_orders = $5,
        remaining_orders = $6,
        bonus_orders = $8,
        bonus_amount = $9,
        deductions = $10,
        daily_total = $11,
        order_value = $7
    `, [courierId, appType, date, DAILY_TARGET_ORDERS, completedOrders, remainingOrders, 
        orderValue, bonusOrders, bonusAmount, deductionAmount, dailyTotal]);

    return {
      completedOrders,
      remainingOrders,
      missedOrders,
      bonusOrders,
      bonusAmount,
      deductionAmount,
      dailyTotal,
      totalFees
    };
  } catch (err) {
    console.error('Error updating daily summary:', err);
    throw err;
  }
};

// تحديث التقرير الأسبوعي
const updateWeeklyReport = async (courierId, appType, year, weekNumber) => {
  try {
    const startDateResult = await pool.query(`
      SELECT date_trunc('week', make_date($1, 1, 1) + ($2 - 1) * interval '1 week')::date as start_date
    `, [year, weekNumber]);

    const startDate = startDateResult.rows[0]?.start_date;
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);

    const summaryResult = await pool.query(`
      SELECT 
        COALESCE(SUM(completed_orders), 0) as total_orders,
        COALESCE(SUM(target_orders), 0) as target_orders,
        COALESCE(SUM(bonus_orders), 0) as bonus_orders,
        COALESCE(SUM(bonus_amount), 0) as bonus_amount,
        COALESCE(SUM(deductions), 0) as deductions,
        COALESCE(SUM(daily_total), 0) as net_total
      FROM daily_orders_summary
      WHERE courier_id = $1 AND app_type = $2 
      AND date >= $3 AND date <= $4
    `, [courierId, appType, startDate, endDate]);

    const data = summaryResult.rows[0];
    const completedTarget = Math.min(parseInt(data.total_orders), parseInt(data.target_orders));
    const missedOrders = Math.max(0, parseInt(data.target_orders) - parseInt(data.total_orders));

    await pool.query(`
      INSERT INTO weekly_reports 
      (courier_id, app_type, year, week_number, start_date, end_date,
       total_orders, target_orders, completed_target, missed_orders,
       bonus_orders, bonus_amount, deductions, net_total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (courier_id, app_type, year, week_number)
      DO UPDATE SET
        total_orders = $7,
        target_orders = $8,
        completed_target = $9,
        missed_orders = $10,
        bonus_orders = $11,
        bonus_amount = $12,
        deductions = $13,
        net_total = $14
    `, [courierId, appType, year, weekNumber, startDate, endDate,
        data.total_orders, data.target_orders, completedTarget, missedOrders,
        data.bonus_orders, data.bonus_amount, data.deductions, data.net_total]);

    return data;
  } catch (err) {
    console.error('Error updating weekly report:', err);
    throw err;
  }
};

// تحديث التقرير الشهري
const updateMonthlyReport = async (courierId, appType, year, month) => {
  try {
    const summaryResult = await pool.query(`
      SELECT 
        COALESCE(SUM(completed_orders), 0) as total_orders,
        COALESCE(SUM(target_orders), 0) as target_orders,
        COALESCE(SUM(bonus_orders), 0) as bonus_orders,
        COALESCE(SUM(bonus_amount), 0) as bonus_amount,
        COALESCE(SUM(deductions), 0) as deductions,
        COALESCE(SUM(daily_total), 0) as net_total
      FROM daily_orders_summary
      WHERE courier_id = $1 AND app_type = $2 
      AND EXTRACT(YEAR FROM date) = $3 AND EXTRACT(MONTH FROM date) = $4
    `, [courierId, appType, year, month]);

    const data = summaryResult.rows[0];
    const completedTarget = Math.min(parseInt(data.total_orders), parseInt(data.target_orders));
    const missedOrders = Math.max(0, parseInt(data.target_orders) - parseInt(data.total_orders));
    const netSalary = MONTHLY_SALARY + parseFloat(data.bonus_amount) - parseFloat(data.deductions);

    await pool.query(`
      INSERT INTO monthly_reports 
      (courier_id, app_type, year, month, total_orders, target_orders, 
       completed_target, missed_orders, bonus_orders, base_salary,
       bonus_amount, deductions, net_salary)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (courier_id, app_type, year, month)
      DO UPDATE SET
        total_orders = $5,
        target_orders = $6,
        completed_target = $7,
        missed_orders = $8,
        bonus_orders = $9,
        bonus_amount = $11,
        deductions = $12,
        net_salary = $13
    `, [courierId, appType, year, month, data.total_orders, data.target_orders,
        completedTarget, missedOrders, data.bonus_orders, MONTHLY_SALARY,
        data.bonus_amount, data.deductions, netSalary]);

    return {
      ...data,
      completedTarget,
      missedOrders,
      netSalary
    };
  } catch (err) {
    console.error('Error updating monthly report:', err);
    throw err;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL SERVICE
// ═══════════════════════════════════════════════════════════════════════════════
const sendEmail = async (to, subject, htmlContent) => {
  try {
    const info = await transporter.sendMail({
      from: '"ود حنين - نظام المندوبين" <noreply@wad-haneen.com>',
      to: to,
      subject: subject,
      html: htmlContent
    });
    console.log('📧 Email sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('❌ Email error:', err);
    return false;
  }
};

// قوالب البريد الإلكتروني
const getAppClosedEmail = (courier, time) => `
<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"><style>
body{font-family:'Cairo',Arial,sans-serif;background:#f5f5f5;direction:rtl;}
.container{max-width:600px;margin:0 auto;background:#fff;}
.header{background:#1a1a2e;padding:30px;text-align:center;border-bottom:4px solid #e94560;}
.logo{width:80px;height:80px;background:#e94560;border-radius:50%;margin:0 auto 15px;color:white;font-size:24px;font-weight:bold;display:flex;align-items:center;justify-content:center;}
.header h1{color:#fff;font-size:22px;}
.alert-box{background:#fff5f5;border-right:5px solid #e74c3c;padding:25px;margin:20px;border-radius:8px;}
.alert-title{color:#e74c3c;font-size:20px;font-weight:700;text-align:center;margin-bottom:15px;}
.detail-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f0f0f0;}
.detail-label{color:#666;font-weight:600;}
.detail-value{color:#1a1a2e;font-weight:700;}
.status-badge{background:#e74c3c;color:white;padding:4px 12px;border-radius:20px;font-size:12px;}
.footer{background:#1a1a2e;padding:25px;text-align:center;color:#888;font-size:13px;}
</style></head>
<body>
<div class="container">
<div class="header"><div class="logo">ود حنين</div><h1>نظام إدارة المندوبين</h1></div>
<div class="alert-box">
<div class="alert-title">⚠️ تنبيه: المندوب أغلق التطبيق!</div>
<div style="background:#fff;padding:20px;border-radius:8px;border:1px solid #eee;">
<div class="detail-row"><span class="detail-label">اسم المندوب:</span><span class="detail-value">${courier.name}</span></div>
<div class="detail-row"><span class="detail-label">رقم الهاتف:</span><span class="detail-value">${courier.phone || 'غير متوفر'}</span></div>
<div class="detail-row"><span class="detail-label">التطبيق:</span><span class="detail-value">${courier.app_type}</span></div>
<div class="detail-row"><span class="detail-label">الحالة:</span><span class="detail-value"><span class="status-badge">غير متصل</span></span></div>
<div class="detail-row"><span class="detail-label">وقت الإغلاق:</span><span class="detail-value">${time}</span></div>
</div></div>
<div style="text-align:center;color:#999;font-size:12px;margin:10px 0;">تم إرسال هذا التنبيه في: ${time}</div>
<div class="footer"><p>© 2026 شركة ود حنين - جميع الحقوق محفوظة</p></div>
</div></body></html>`;

const getIdleEmail = (courier, duration, time) => `
<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"><style>
body{font-family:'Cairo',Arial,sans-serif;background:#f5f5f5;direction:rtl;}
.container{max-width:600px;margin:0 auto;background:#fff;}
.header{background:#1a1a2e;padding:30px;text-align:center;border-bottom:4px solid #f39c12;}
.logo{width:80px;height:80px;background:#f39c12;border-radius:50%;margin:0 auto 15px;color:white;font-size:24px;font-weight:bold;display:flex;align-items:center;justify-content:center;}
.header h1{color:#fff;font-size:22px;}
.alert-box{background:#fffbf0;border-right:5px solid #f39c12;padding:25px;margin:20px;border-radius:8px;}
.alert-title{color:#f39c12;font-size:20px;font-weight:700;text-align:center;margin-bottom:15px;}
.duration-highlight{background:#f39c12;color:white;padding:15px;border-radius:8px;text-align:center;font-size:24px;font-weight:700;margin:15px 0;}
.detail-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f0f0f0;}
.detail-label{color:#666;font-weight:600;}
.detail-value{color:#1a1a2e;font-weight:700;}
.footer{background:#1a1a2e;padding:25px;text-align:center;color:#888;font-size:13px;}
</style></head>
<body>
<div class="container">
<div class="header"><div class="logo">ود حنين</div><h1>نظام إدارة المندوبين</h1></div>
<div class="alert-box">
<div class="alert-title">⏸️ تنبيه: المندوب غافل!</div>
<div class="duration-highlight">مدة الغفلة: ${duration}</div>
<div style="background:#fff;padding:20px;border-radius:8px;border:1px solid #eee;">
<div class="detail-row"><span class="detail-label">اسم المندوب:</span><span class="detail-value">${courier.name}</span></div>
<div class="detail-row"><span class="detail-label">التطبيق:</span><span class="detail-value">${courier.app_type}</span></div>
<div class="detail-row"><span class="detail-label">وقت بداية الغفلة:</span><span class="detail-value">${time}</span></div>
</div></div>
<div style="text-align:center;color:#999;font-size:12px;margin:10px 0;">تم إرسال هذا التنبيه في: ${time}</div>
<div class="footer"><p>© 2026 شركة ود حنين - جميع الحقوق محفوظة</p></div>
</div></body></html>`;

const getDailyReportEmail = (courier, report, date) => `
<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"><style>
body{font-family:'Cairo',Arial,sans-serif;background:#f5f5f5;direction:rtl;}
.container{max-width:600px;margin:0 auto;background:#fff;}
.header{background:#1a1a2e;padding:30px;text-align:center;border-bottom:4px solid #3498db;}
.logo{width:80px;height:80px;background:#3498db;border-radius:50%;margin:0 auto 15px;color:white;font-size:24px;font-weight:bold;display:flex;align-items:center;justify-content:center;}
.header h1{color:#fff;font-size:22px;}
.report-box{background:#f0f8ff;border-right:5px solid #3498db;padding:25px;margin:20px;border-radius:8px;}
.report-title{color:#3498db;font-size:20px;font-weight:700;text-align:center;margin-bottom:15px;}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:15px 0;}
.stat-box{background:#fff;padding:15px;border-radius:8px;text-align:center;border:1px solid #eee;}
.stat-number{font-size:28px;font-weight:700;color:#1a1a2e;}
.stat-label{font-size:12px;color:#888;margin-top:5px;}
.detail-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f0f0f0;}
.detail-label{color:#666;font-weight:600;}
.detail-value{color:#1a1a2e;font-weight:700;}
.positive{color:#2ecc71;}
.negative{color:#e74c3c;}
.footer{background:#1a1a2e;padding:25px;text-align:center;color:#888;font-size:13px;}
</style></head>
<body>
<div class="container">
<div class="header"><div class="logo">ود حنين</div><h1>نظام إدارة المندوبين</h1></div>
<div class="report-box">
<div class="report-title">📊 التقرير اليومي</div>
<div style="background:#fff;padding:20px;border-radius:8px;border:1px solid #eee;">
<div class="detail-row"><span class="detail-label">اسم المندوب:</span><span class="detail-value">${courier.name}</span></div>
<div class="detail-row"><span class="detail-label">التطبيق:</span><span class="detail-value">${courier.app_type}</span></div>
<div class="detail-row"><span class="detail-label">التاريخ:</span><span class="detail-value">${date}</span></div>
<div class="stat-grid">
<div class="stat-box"><div class="stat-number">${report.completedOrders}</div><div class="stat-label">طلبات موصلة</div></div>
<div class="stat-box"><div class="stat-number">${report.remainingOrders}</div><div class="stat-label">طلبات متبقية</div></div>
<div class="stat-box"><div class="stat-number ${report.bonusOrders > 0 ? 'positive' : ''}">${report.bonusOrders}</div><div class="stat-label">طلبات بونص</div></div>
<div class="stat-box"><div class="stat-number ${report.missedOrders > 0 ? 'negative' : ''}">${report.missedOrders}</div><div class="stat-label">طلبات فائتة</div></div>
</div>
<div class="detail-row"><span class="detail-label">قيمة الطلب الواحد:</span><span class="detail-value">${report.orderValue} ريال</span></div>
<div class="detail-row"><span class="detail-label">مبلغ البونص:</span><span class="detail-value positive">${report.bonusAmount} ريال</span></div>
<div class="detail-row"><span class="detail-label">مبلغ الخصم:</span><span class="detail-value negative">${report.deductionAmount} ريال</span></div>
<div class="detail-row" style="border-top:2px solid #3498db;padding-top:15px;margin-top:15px;"><span class="detail-label">الإجمالي اليومي:</span><span class="detail-value" style="font-size:20px;color:#3498db;">${report.dailyTotal} ريال</span></div>
</div></div>
<div style="text-align:center;color:#999;font-size:12px;margin:10px 0;">تم إنشاء هذا التقرير في: ${date}</div>
<div class="footer"><p>© 2026 شركة ود حنين - جميع الحقوق محفوظة</p></div>
</div></body></html>`;

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── AUTH ROUTES ──
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── COURIER ROUTES ──
app.get('/api/couriers', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM activity_logs WHERE courier_id = c.id AND action = 'app_closed') as close_count,
        (SELECT COUNT(*) FROM activity_logs WHERE courier_id = c.id AND action = 'idle_start') as idle_count_total,
        (SELECT COUNT(*) FROM orders WHERE courier_id = c.id AND delivery_date = CURRENT_DATE AND status = 'delivered') as today_orders
      FROM couriers c
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/couriers', authenticateToken, async (req, res) => {
  try {
    const { name, phone, email, app_type, app_user_id, shift_start, shift_end, daily_target, monthly_salary } = req.body;
    const result = await pool.query(`
      INSERT INTO couriers (name, phone, email, app_type, app_user_id, shift_start, shift_end, daily_target, monthly_salary)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, phone, email, app_type, app_user_id, shift_start, shift_end, daily_target || 17, monthly_salary || 6500]);

    io.emit('courier_added', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/couriers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, app_type, status, is_online, daily_target, monthly_salary } = req.body;

    const result = await pool.query(`
      UPDATE couriers 
      SET name = $1, phone = $2, email = $3, app_type = $4, status = $5, is_online = $6, 
          daily_target = $7, monthly_salary = $8, updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
    `, [name, phone, email, app_type, status, is_online, daily_target, monthly_salary, id]);

    io.emit('courier_updated', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/couriers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM couriers WHERE id = $1', [id]);
    io.emit('courier_deleted', { id });
    res.json({ message: 'Courier deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ORDERS ROUTES (طلبات جديدة) ──
app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { courier_id, order_number, app_type, order_value, delivery_fee, customer_name, customer_phone, notes } = req.body;

    const result = await pool.query(`
      INSERT INTO orders (courier_id, order_number, app_type, order_value, delivery_fee, customer_name, customer_phone, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [courier_id, order_number, app_type, order_value, delivery_fee, customer_name, customer_phone, notes]);

    // تحديث ملخص اليوم
    const today = new Date().toISOString().split('T')[0];
    await updateDailySummary(courier_id, app_type, today);

    // تحديث عدد الطلبات الحالية للمندوب
    await pool.query(`
      UPDATE couriers SET current_orders = current_orders + 1 WHERE id = $1
    `, [courier_id]);

    io.emit('order_added', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/:courierId', authenticateToken, async (req, res) => {
  try {
    const { courierId } = req.params;
    const { date, app_type } = req.query;

    let query = 'SELECT * FROM orders WHERE courier_id = $1';
    let params = [courierId];
    let paramIndex = 2;

    if (date) {
      query += ` AND delivery_date = $${paramIndex}`;
      params.push(date);
      paramIndex++;
    }

    if (app_type) {
      query += ` AND app_type = $${paramIndex}`;
      params.push(app_type);
      paramIndex++;
    }

    query += ' ORDER BY delivery_time DESC LIMIT 200';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const order = orderResult.rows[0];

    await pool.query('DELETE FROM orders WHERE id = $1', [id]);

    if (order) {
      const today = new Date().toISOString().split('T')[0];
      await updateDailySummary(order.courier_id, order.app_type, today);

      await pool.query(`
        UPDATE couriers SET current_orders = GREATEST(current_orders - 1, 0) WHERE id = $1
      `, [order.courier_id]);
    }

    io.emit('order_deleted', { id });
    res.json({ message: 'Order deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DAILY SUMMARY ROUTES ──
app.get('/api/daily-summary/:courierId', authenticateToken, async (req, res) => {
  try {
    const { courierId } = req.params;
    const { date, app_type } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    // تحديث الملخص أولاً
    if (app_type) {
      await updateDailySummary(courierId, app_type, targetDate);
    } else {
      // تحديث لكل تطبيقات المندوب
      const appsResult = await pool.query('SELECT DISTINCT app_type FROM orders WHERE courier_id = $1', [courierId]);
      for (const row of appsResult.rows) {
        await updateDailySummary(courierId, row.app_type, targetDate);
      }
    }

    let query = `
      SELECT d.*, c.name as courier_name
      FROM daily_orders_summary d
      JOIN couriers c ON d.courier_id = c.id
      WHERE d.courier_id = $1 AND d.date = $2
    `;
    let params = [courierId, targetDate];

    if (app_type) {
      query += ' AND d.app_type = $3';
      params.push(app_type);
    }

    query += ' ORDER BY d.app_type';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily-summary-all', authenticateToken, async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const result = await pool.query(`
      SELECT d.*, c.name as courier_name, c.phone as courier_phone
      FROM daily_orders_summary d
      JOIN couriers c ON d.courier_id = c.id
      WHERE d.date = $1
      ORDER BY c.name, d.app_type
    `, [targetDate]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WEEKLY REPORTS ROUTES ──
app.get('/api/weekly-reports/:courierId', authenticateToken, async (req, res) => {
  try {
    const { courierId } = req.params;
    const { year, week, app_type } = req.query;
    const targetYear = year || new Date().getFullYear();
    const targetWeek = week || getWeekNumber(new Date());

    if (app_type) {
      await updateWeeklyReport(courierId, app_type, targetYear, targetWeek);
    }

    let query = `
      SELECT w.*, c.name as courier_name
      FROM weekly_reports w
      JOIN couriers c ON w.courier_id = c.id
      WHERE w.courier_id = $1 AND w.year = $2 AND w.week_number = $3
    `;
    let params = [courierId, targetYear, targetWeek];

    if (app_type) {
      query += ' AND w.app_type = $4';
      params.push(app_type);
    }

    query += ' ORDER BY w.app_type';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/weekly-reports-all', authenticateToken, async (req, res) => {
  try {
    const { year, week } = req.query;
    const targetYear = year || new Date().getFullYear();
    const targetWeek = week || getWeekNumber(new Date());

    const result = await pool.query(`
      SELECT w.*, c.name as courier_name
      FROM weekly_reports w
      JOIN couriers c ON w.courier_id = c.id
      WHERE w.year = $1 AND w.week_number = $2
      ORDER BY c.name, w.app_type
    `, [targetYear, targetWeek]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MONTHLY REPORTS ROUTES ──
app.get('/api/monthly-reports/:courierId', authenticateToken, async (req, res) => {
  try {
    const { courierId } = req.params;
    const { year, month, app_type } = req.query;
    const targetYear = year || new Date().getFullYear();
    const targetMonth = month || (new Date().getMonth() + 1);

    if (app_type) {
      await updateMonthlyReport(courierId, app_type, targetYear, targetMonth);
    }

    let query = `
      SELECT m.*, c.name as courier_name
      FROM monthly_reports m
      JOIN couriers c ON m.courier_id = c.id
      WHERE m.courier_id = $1 AND m.year = $2 AND m.month = $3
    `;
    let params = [courierId, targetYear, targetMonth];

    if (app_type) {
      query += ' AND m.app_type = $4';
      params.push(app_type);
    }

    query += ' ORDER BY m.app_type';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monthly-reports-all', authenticateToken, async (req, res) => {
  try {
    const { year, month } = req.query;
    const targetYear = year || new Date().getFullYear();
    const targetMonth = month || (new Date().getMonth() + 1);

    const result = await pool.query(`
      SELECT m.*, c.name as courier_name
      FROM monthly_reports m
      JOIN couriers c ON m.courier_id = c.id
      WHERE m.year = $1 AND m.month = $2
      ORDER BY c.name, m.app_type
    `, [targetYear, targetMonth]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FULL YEAR REPORT ──
app.get('/api/yearly-report/:courierId', authenticateToken, async (req, res) => {
  try {
    const { courierId } = req.params;
    const { year, app_type } = req.query;
    const targetYear = year || new Date().getFullYear();

    let query = `
      SELECT 
        m.year,
        m.month,
        m.app_type,
        c.name as courier_name,
        SUM(m.total_orders) as total_orders,
        SUM(m.target_orders) as target_orders,
        SUM(m.completed_target) as completed_target,
        SUM(m.missed_orders) as missed_orders,
        SUM(m.bonus_orders) as bonus_orders,
        SUM(m.base_salary) as total_base_salary,
        SUM(m.bonus_amount) as total_bonus,
        SUM(m.deductions) as total_deductions,
        SUM(m.net_salary) as total_net_salary
      FROM monthly_reports m
      JOIN couriers c ON m.courier_id = c.id
      WHERE m.courier_id = $1 AND m.year = $2
    `;
    let params = [courierId, targetYear];

    if (app_type) {
      query += ' AND m.app_type = $3';
      params.push(app_type);
    }

    query += ' GROUP BY m.year, m.month, m.app_type, c.name ORDER BY m.month, m.app_type';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DASHBOARD STATS ──
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    // إحصائيات المندوبين
    const couriersStats = await pool.query(`
      SELECT 
        COUNT(*) as total_couriers,
        COUNT(CASE WHEN is_online = TRUE THEN 1 END) as online_couriers,
        COUNT(CASE WHEN app_type = 'ninja_restaurant' THEN 1 END) as ninja_restaurant_count,
        COUNT(CASE WHEN app_type = 'ninja_grocery' THEN 1 END) as ninja_grocery_count
      FROM couriers
    `);

    // إحصائيات الطلبات اليوم
    const todayOrders = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(delivery_fee), 0) as total_fees,
        COUNT(CASE WHEN app_type = 'ninja_restaurant' THEN 1 END) as restaurant_orders,
        COUNT(CASE WHEN app_type = 'ninja_grocery' THEN 1 END) as grocery_orders
      FROM orders
      WHERE delivery_date = $1
    `, [today]);

    // إحصائيات الشهر
    const monthStats = await pool.query(`
      SELECT 
        COALESCE(SUM(completed_orders), 0) as total_month_orders,
        COALESCE(SUM(bonus_amount), 0) as total_bonus,
        COALESCE(SUM(deductions), 0) as total_deductions,
        COALESCE(SUM(daily_total), 0) as total_revenue
      FROM daily_orders_summary
      WHERE EXTRACT(YEAR FROM date) = $1 AND EXTRACT(MONTH FROM date) = $2
    `, [currentYear, currentMonth]);

    // أفضل المندوبين
    const topCouriers = await pool.query(`
      SELECT 
        c.name,
        c.app_type,
        COUNT(o.id) as order_count
      FROM couriers c
      LEFT JOIN orders o ON c.id = o.courier_id AND o.delivery_date = $1
      GROUP BY c.id, c.name, c.app_type
      ORDER BY order_count DESC
      LIMIT 5
    `, [today]);

    res.json({
      couriers: couriersStats.rows[0],
      today_orders: todayOrders.rows[0],
      month_stats: monthStats.rows[0],
      top_couriers: topCouriers.rows,
      settings: {
        daily_target: DAILY_TARGET_ORDERS,
        monthly_salary: MONTHLY_SALARY,
        order_value: calculateOrderValue(),
        bonus_per_order: BONUS_PER_ORDER
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ACTIVITY LOGS ROUTES ──
app.post('/api/activity-logs', authenticateToken, async (req, res) => {
  try {
    const { courier_id, action, app_type, duration, location_lat, location_lng } = req.body;

    const result = await pool.query(`
      INSERT INTO activity_logs (courier_id, action, app_type, duration, location_lat, location_lng)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [courier_id, action, app_type, duration, location_lat, location_lng]);

    if (action === 'app_closed') {
      await pool.query('UPDATE couriers SET status = $1, is_online = FALSE WHERE id = $2', ['offline', courier_id]);

      const courierResult = await pool.query('SELECT * FROM couriers WHERE id = $1', [courier_id]);
      const courier = courierResult.rows[0];
      const now = new Date().toLocaleString('ar-SA');

      await sendEmail(
        'aehab1414@gmail.com',
        `⚠️ تنبيه: المندوب ${courier.name} أغلق التطبيق`,
        getAppClosedEmail(courier, now)
      );

      await pool.query(`
        INSERT INTO alerts (courier_id, alert_type, message, sent_email)
        VALUES ($1, $2, $3, TRUE)
      `, [courier_id, 'app_closed', `المندوب ${courier.name} أغلق التطبيق ${app_type}`]);
    }

    if (action === 'idle_start') {
      await pool.query('UPDATE couriers SET status = $1 WHERE id = $2', ['idle', courier_id]);

      const courierResult = await pool.query('SELECT * FROM couriers WHERE id = $1', [courier_id]);
      const courier = courierResult.rows[0];
      const now = new Date().toLocaleString('ar-SA');

      await sendEmail(
        'aehab1414@gmail.com',
        `🟡 تنبيه: المندوب ${courier.name} غافل`,
        getIdleEmail(courier, `${duration} دقيقة`, now)
      );

      await pool.query(`
        INSERT INTO alerts (courier_id, alert_type, message, sent_email)
        VALUES ($1, $2, $3, TRUE)
      `, [courier_id, 'idle', `المندوب ${courier.name} غافل لمدة ${duration} دقيقة`]);
    }

    if (action === 'app_opened' || action === 'idle_end') {
      await pool.query('UPDATE couriers SET status = $1, is_online = TRUE WHERE id = $2', ['active', courier_id]);
    }

    if (action === 'shift_start') {
      await pool.query('UPDATE couriers SET status = $1, is_online = TRUE WHERE id = $2', ['active', courier_id]);
    }

    io.emit('activity_logged', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/activity-logs/:courierId', authenticateToken, async (req, res) => {
  try {
    const { courierId } = req.params;
    const result = await pool.query(`
      SELECT * FROM activity_logs 
      WHERE courier_id = $1 
      ORDER BY timestamp DESC 
      LIMIT 100
    `, [courierId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ALERTS ROUTES ──
app.get('/api/alerts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, c.name as courier_name, c.app_type
      FROM alerts a
      JOIN couriers c ON a.courier_id = c.id
      ORDER BY a.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEND DAILY REPORT EMAIL ──
app.post('/api/send-daily-report/:courierId', authenticateToken, async (req, res) => {
  try {
    const { courierId } = req.params;
    const { date } = req.body;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const courierResult = await pool.query('SELECT * FROM couriers WHERE id = $1', [courierId]);
    const courier = courierResult.rows[0];

    if (!courier) {
      return res.status(404).json({ error: 'Courier not found' });
    }

    const report = await updateDailySummary(courierId, courier.app_type, targetDate);
    const now = new Date().toLocaleString('ar-SA');

    await sendEmail(
      courier.email || 'aehab1414@gmail.com',
      `📊 تقرير يومي - ${courier.name} - ${targetDate}`,
      getDailyReportEmail(courier, report, targetDate)
    );

    res.json({ message: 'Daily report sent successfully', report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── APP INTEGRATIONS ROUTES ──
app.get('/api/app-integrations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM app_integrations');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/app-integrations', authenticateToken, async (req, res) => {
  try {
    const { app_name, app_type, api_key, api_secret, webhook_url } = req.body;
    const result = await pool.query(`
      INSERT INTO app_integrations (app_name, app_type, api_key, api_secret, webhook_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [app_name, app_type, api_key, api_secret, webhook_url]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});


// ── CONSENT-BASED LIVE LOCATION ──
// The courier's mobile app must explicitly grant location permission and send real GPS coordinates.
// This API does not spoof GPS or alter the courier's position.
app.post('/api/couriers/:id/location', authenticateToken, async (req, res) => {
  try {
    const courierId = Number(req.params.id);
    const { latitude, longitude, accuracy_m, consent } = req.body || {};
    if (!Number.isInteger(courierId) || courierId <= 0) {
      return res.status(400).json({ error: 'Invalid courier id' });
    }
    if (consent !== true) {
      return res.status(403).json({ error: 'Courier location permission/consent is required' });
    }
    const lat = Number(latitude), lng = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }
    const courier = await pool.query('SELECT id FROM couriers WHERE id = $1', [courierId]);
    if (!courier.rowCount) return res.status(404).json({ error: 'Courier not found' });

    const result = await pool.query(`
      INSERT INTO courier_locations (courier_id, latitude, longitude, accuracy_m)
      VALUES ($1, $2, $3, $4)
      RETURNING id, courier_id, latitude, longitude, accuracy_m, recorded_at
    `, [courierId, lat, lng, Number.isFinite(Number(accuracy_m)) ? Number(accuracy_m) : null]);
    io.emit('courier_location_updated', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Unable to save location' });
  }
});

app.get('/api/live-locations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (c.id)
        c.id AS courier_id, c.name, c.phone, c.app_type, c.status, c.is_online,
        l.latitude, l.longitude, l.accuracy_m, l.recorded_at
      FROM couriers c
      JOIN courier_locations l ON l.courier_id = c.id
      WHERE l.recorded_at >= NOW() - INTERVAL '24 hours'
      ORDER BY c.id, l.recorded_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Unable to load live locations' });
  }
});

// Ninja / SAMURAI connector foundation.
// Only connect through API endpoints and credentials explicitly authorized by Ninja.
// Do not automate portal login with a user's password or reuse browser session cookies.
app.get('/api/integrations/ninja/status', authenticateToken, (req, res) => {
  const configured = Boolean(
    process.env.NINJA_API_BASE_URL &&
    process.env.NINJA_API_TOKEN &&
    process.env.NINJA_HEALTH_PATH
  );
  res.json({
    provider: 'Ninja / SAMURAI Portal',
    configured,
    mode: configured ? 'official_api_configured' : 'waiting_for_official_api_details',
    base_url_configured: Boolean(process.env.NINJA_API_BASE_URL),
    token_configured: Boolean(process.env.NINJA_API_TOKEN),
    health_path_configured: Boolean(process.env.NINJA_HEALTH_PATH),
    last_test_at: ninjaLastTestAt,
    last_test_ok: ninjaLastTestOk,
    last_test_message: ninjaLastTestMessage,
    message: configured
      ? 'API settings are present. Run the connection test and confirm the official endpoint contract with Ninja.'
      : 'Need the official API base URL, authorized API token, and health/test endpoint from Ninja. Portal username/password alone are not enough for a stable integration.'
  });
});

let ninjaLastTestAt = null;
let ninjaLastTestOk = null;
let ninjaLastTestMessage = 'Not tested';

app.post('/api/integrations/ninja/test', authenticateToken, async (req, res) => {
  const baseUrl = process.env.NINJA_API_BASE_URL;
  const token = process.env.NINJA_API_TOKEN;
  const healthPath = process.env.NINJA_HEALTH_PATH;
  if (!baseUrl || !token || !healthPath) {
    return res.status(400).json({
      ok: false,
      code: 'NINJA_API_NOT_CONFIGURED',
      message: 'Set NINJA_API_BASE_URL, NINJA_API_TOKEN, and NINJA_HEALTH_PATH using official details supplied by Ninja.'
    });
  }

  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      return res.status(400).json({ ok: false, code: 'HTTPS_REQUIRED', message: 'Ninja API must use HTTPS in production.' });
    }
    const target = new URL(healthPath, base);
    if (target.origin !== base.origin) {
      return res.status(400).json({ ok: false, code: 'INVALID_HEALTH_PATH', message: 'Health path must remain on the configured Ninja API host.' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let upstream;
    try {
      upstream = await fetch(target, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    ninjaLastTestAt = new Date().toISOString();
    ninjaLastTestOk = upstream.ok;
    ninjaLastTestMessage = upstream.ok
      ? `Ninja API responded with HTTP ${upstream.status}.`
      : `Ninja API returned HTTP ${upstream.status}; check token, endpoint, and permissions.`;
    // Do not return upstream response bodies or secrets to the client.
    res.status(upstream.ok ? 200 : 502).json({
      ok: upstream.ok,
      provider: 'Ninja / SAMURAI Portal',
      http_status: upstream.status,
      tested_at: ninjaLastTestAt,
      message: ninjaLastTestMessage
    });
  } catch (err) {
    ninjaLastTestAt = new Date().toISOString();
    ninjaLastTestOk = false;
    ninjaLastTestMessage = err.name === 'AbortError'
      ? 'Connection test timed out after 10 seconds.'
      : 'Connection test failed; verify the official API URL and server network access.';
    res.status(502).json({ ok: false, tested_at: ninjaLastTestAt, message: ninjaLastTestMessage });
  }
});

// Shift monitor: checks shift start and sends dashboard/email alerts if no app_opened/shift_start event arrived.
// Run once per minute. Alerts are deduplicated by courier/date/type.
async function checkCourierShiftAlerts() {
  try {
    const result = await pool.query(`
      SELECT id, name, phone, email, app_type, shift_start, is_online, status
      FROM couriers
      WHERE shift_start IS NOT NULL
    `);
    const now = new Date();
    const riyadhParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit',
      year: 'numeric', month: '2-digit', day: '2-digit', hour12: false
    }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    const today = `${riyadhParts.year}-${riyadhParts.month}-${riyadhParts.day}`;
    const nowMins = Number(riyadhParts.hour) * 60 + Number(riyadhParts.minute);

    for (const c of result.rows) {
      const [hh, mm] = String(c.shift_start).slice(0, 5).split(':').map(Number);
      const shiftMins = hh * 60 + mm;
      const minutesUntil = shiftMins - nowMins;
      let type = null, message = null;
      if (minutesUntil === 10 && !c.is_online) {
        type = 'shift_reminder';
        message = `تذكير: دوام ${c.name} يبدأ بعد 10 دقائق ولم يظهر أنه فتح التطبيق.`;
      } else if (minutesUntil <= 0 && minutesUntil >= -2 && !c.is_online) {
        type = 'shift_not_started';
        message = `إنذار: بدأ دوام ${c.name} ولم يصل تسجيل فتح التطبيق.`;
      }
      if (!type) continue;

      const inserted = await pool.query(`
        INSERT INTO shift_alert_dedup (courier_id, alert_date, alert_type)
        VALUES ($1, $2, $3)
        ON CONFLICT (courier_id, alert_date, alert_type) DO NOTHING
        RETURNING id
      `, [c.id, today, type]);
      if (!inserted.rowCount) continue;

      await pool.query(`
        INSERT INTO alerts (courier_id, alert_type, message, sent_email)
        VALUES ($1, $2, $3, FALSE)
      `, [c.id, type, message]);

      io.emit('shift_alert', { courier_id: c.id, courier_name: c.name, alert_type: type, message, created_at: now.toISOString() });
      if (process.env.ALERT_EMAIL) {
        const html = `<div style="font-family:Arial,sans-serif"><h2>${type === 'shift_reminder' ? 'Shift reminder' : 'Missed shift alert'}</h2><p>${message}</p><p>Courier: ${c.name}</p><p>App: ${c.app_type}</p></div>`;
        await sendEmail(process.env.ALERT_EMAIL, `Wad Haneen: ${type} - ${c.name}`, html);
      }
    }
  } catch (err) {
    console.error('Shift alert check failed:', err.message);
  }
}
setInterval(checkCourierShiftAlerts, 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER START
// ═══════════════════════════════════════════════════════════════════════════════
server.listen(PORT, async () => {
  await initDatabase();
  try { await pool.query('SELECT 1'); }
  catch (err) { console.error('Database unavailable at startup:', err.message); process.exit(1); }
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║     🚀 ود حنين - نظام إدارة المندوبين v3.0               ║
  ║     Wad Haneen - Courier Management System               ║
  ║                                                           ║
  ║     ✅ دعم نينجا مطعم ونينجا بقالة                       ║
  ║     ✅ تقارير يومية وأسبوعية وشهرية                      ║
  ║     ✅ حساب البونص والخصومات                             ║
  ║                                                           ║
  ║     Server running on port: ${PORT}                        ║
  ║     http://localhost:${PORT}                               ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
  `);
});

module.exports = { app, server, pool };
