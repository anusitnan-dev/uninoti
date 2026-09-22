const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); 
const cron = require('node-cron');
const { Expo } = require('expo-server-sdk');
const expo = new Expo();

const app = express();
// 🟢 จุดที่ 1: ปรับ Port ให้รองรับ Environment Variable บน Render
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    cb(null, 'profile_' + Date.now() + path.extname(file.originalname))
  }
});
const upload = multer({ storage: storage });

// 🟢 จุดที่ 2: ปรับการเชื่อมต่อ Database ให้ใช้กับ TiDB Cloud
const db = mysql.createPool({
  host: process.env.DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com', // ค่า Host TiDB
  port: process.env.DB_PORT || 4000,                                             // Port TiDB คือ 4000
  user: process.env.DB_USER || 'BJGnErUr2BJSKDf.root',                       // เช่น xxxxx.root
  password: process.env.DB_PASSWORD || 'MooR2wlhLmTkOC1k',                   // รหัสผ่าน TiDB
  database: process.env.DB_NAME || 'test',                                       // ชื่อฐานข้อมูลบน TiDB (test)
  dateStrings: true, 
  timezone: '+07:00',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false                                                    // **สำคัญมาก** บังคับใช้ SSL เชื่อมคลาวด์
  }
});

db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ เชื่อมต่อ MySQL ไม่สำเร็จ:', err);
    return;
  }
  console.log('✅ เชื่อมต่อ TiDB Cloud (test) สำเร็จแล้ว!');
  connection.release();
});

app.get('/', (req, res) => {
  res.send('สวัสดี! นี่คือ API ของแอป Uninoti');
});

app.get('/activities', (req, res) => {
  const userEmail = req.query.email; 
  const searchTerm = req.query.search || ''; 
  let sql = "";
  let params = [];

  if (userEmail && userEmail !== 'User') {
    sql = `
      SELECT a.activity_id, a.title, DATE_FORMAT(a.activity_date, '%Y-%m-%d') AS date, 
             a.start_time, a.location, a.status, a.type_id, a.reminder_minutes, at.type_name, at.color_code
      FROM activities a
      LEFT JOIN users u ON a.user_id = u.user_id
      LEFT JOIN activity_types at ON a.type_id = at.type_id
      WHERE (u.email = ? OR a.user_id IS NULL) AND a.title LIKE ?
      ORDER BY a.activity_date ASC, a.start_time ASC
    `;
    params = [userEmail, `%${searchTerm}%`]; 
  } else {
    sql = `
      SELECT a.activity_id, a.title, DATE_FORMAT(a.activity_date, '%Y-%m-%d') AS date, 
             a.start_time, a.location, a.status, a.type_id, a.reminder_minutes, at.type_name, at.color_code
      FROM activities a
      LEFT JOIN activity_types at ON a.type_id = at.type_id
      WHERE a.title LIKE ?
      ORDER BY a.activity_date ASC, a.start_time ASC
    `;
    params = [`%${searchTerm}%`]; 
  }

  db.query(sql, params, (err, results) => {
    if (err) {
      console.error('❌ เกิดข้อผิดพลาดในการดึงข้อมูล:', err);
      return res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
    }
    res.json(results);
  });
});

app.post('/activities', (req, res) => {
  const { title, date, start_time, location, user_email, type_id, reminder_minutes } = req.body; 

  const sql = `
      INSERT INTO activities (title, activity_date, start_time, location, user_id, type_id, reminder_minutes) 
      VALUES (?, ?, ?, ?, (SELECT user_id FROM users WHERE email = ? LIMIT 1), ?, ?)
  `;

  db.query(sql, [title, date, start_time, location, user_email, type_id || null, reminder_minutes ?? null], (err, result) => {
      if (err) {
          console.error('❌ เกิดข้อผิดพลาดในการเพิ่มกิจกรรม:', err);
          return res.status(500).json({ error: "ไม่สามารถเพิ่มข้อมูลได้" });
      }
      res.status(201).json({ message: "เพิ่มกิจกรรมสำเร็จ", activity_id: result.insertId });
  });
});

app.delete('/activities/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM activities WHERE activity_id = ?';

  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('เกิดข้อผิดพลาดในการลบ:', err);
      return res.status(500).json({ error: 'ลบข้อมูลไม่สำเร็จ' });
    }
    res.json({ message: 'ลบกิจกรรมสำเร็จแล้ว' });
  });
});

app.post('/users', (req, res) => {
  const { email, push_token } = req.body;
  
  if (!email) return res.status(400).json({ error: 'ไม่พบอีเมล' });

  const sql = `
    INSERT INTO users (email, push_token) 
    VALUES (?, ?) 
    ON DUPLICATE KEY UPDATE push_token = VALUES(push_token)
  `;
  
  db.query(sql, [email, push_token || null], (err, result) => {
    if (err) {
      console.error('❌ เกิดข้อผิดพลาดในการบันทึกผู้ใช้/Push Token:', err);
      return res.status(500).json({ error: 'ไม่สามารถเพิ่มข้อมูลผู้ใช้ได้' });
    }
    res.status(200).json({ message: 'ซิงค์ข้อมูลผู้ใช้และ Push Token สำเร็จ' });
  });
});

app.put('/activities/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body; 

  const query = 'UPDATE activities SET status = ? WHERE activity_id = ?';

  db.query(query, [status, id], (err, result) => {
    if (err) {
      console.error('❌ เกิดข้อผิดพลาดในการอัปเดตสถานะ:', err);
      return res.status(500).json({ error: 'อัปเดตสถานะไม่สำเร็จ' });
    }
    res.json({ message: 'อัปเดตสถานะกิจกรรมสำเร็จแล้ว' });
  });
});

app.put('/activities/:id', (req, res) => {
  const { id } = req.params;
  const { title, date, start_time, location, type_id, reminder_minutes, status } = req.body;

  const query = `
    UPDATE activities 
    SET title = ?, activity_date = ?, start_time = ?, location = ?, type_id = ?, reminder_minutes = ?,
        status = COALESCE(?, status)
    WHERE activity_id = ?
  `;

  db.query(query, [title, date, start_time, location, type_id || null, reminder_minutes ?? null, status || null, id], (err, result) => {
    if (err) {
      console.error('❌ เกิดข้อผิดพลาดในการแก้ไขกิจกรรม:', err);
      return res.status(500).json({ error: 'ไม่สามารถแก้ไขข้อมูลได้' });
    }
    res.json({ message: 'แก้ไขรายละเอียดกิจกรรมสำเร็จแล้ว ✨' });
  });
});

app.post('/upload-profile', upload.single('profile_image'), (req, res) => {
  const { email } = req.body; 

  if (!req.file) {
    return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพที่อัปโหลด' });
  }

  const newFilename = req.file.filename; 

  const checkSql = "SELECT profile_picture FROM users WHERE email = ?";
  db.query(checkSql, [email], (err, results) => {
    if (err) {
      console.error('❌ ดึงข้อมูลรูปเก่าไม่สำเร็จ:', err);
    } else if (results.length > 0 && results[0].profile_picture) {
      const oldFilename = results[0].profile_picture;
      const oldFilePath = path.join(__dirname, 'uploads', oldFilename);

      fs.unlink(oldFilePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error('⚠️ ไม่สามารถลบรูปเก่าได้ (อาจไม่มีไฟล์นี้ในระบบ):', unlinkErr);
        } else {
          console.log('🗑️ ลบรูปเก่าสำเร็จแล้ว:', oldFilename);
        }
      });
    }

    const updateSql = "UPDATE users SET profile_picture = ? WHERE email = ?";
    db.query(updateSql, [newFilename, email], (updateErr, result) => {
      if (updateErr) {
        console.error('❌ เกิดข้อผิดพลาดในการบันทึกชื่อรูปลง MySQL:', updateErr);
        return res.status(500).json({ error: 'อัปเดตรูปไม่สำเร็จ' });
      }
      
      res.status(200).json({ 
        message: 'อัปโหลดและเปลี่ยนรูปสำเร็จ', 
        fileName: newFilename 
      });
    });
  });
});

app.get('/users/:email', (req, res) => {
  const { email } = req.params;
  const sql = "SELECT profile_picture FROM users WHERE email = ?";
  
  db.query(sql, [email], (err, results) => {
    if (err) {
      console.error('❌ ดึงข้อมูลรูปโปรไฟล์ไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ดึงข้อมูลล้มเหลว' });
    }
    
    if (results.length > 0 && results[0].profile_picture) {
      res.json({ fileName: results[0].profile_picture });
    } else {
      res.json({ fileName: null }); 
    }
  });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  const ADMIN_USERNAME = 'admin';
  const ADMIN_PASSWORD = '1234';

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    res.status(200).json({ 
      message: 'เข้าสู่ระบบสำเร็จ', 
      token: 'admin-secret-token-12345' 
    });
  } else {
    res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
});

app.get('/activity_types', (req, res) => {
  const sql = "SELECT * FROM activity_types ORDER BY type_id DESC";
  
  db.query(sql, (err, results) => {
    if (err) {
      console.error('❌ ดึงข้อมูลประเภทกิจกรรมไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ดึงข้อมูลไม่สำเร็จ' });
    }
    res.json(results);
  });
});

app.post('/activity_types', (req, res) => {
  const { type_name, color_code } = req.body;

  if (!type_name) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อประเภทกิจกรรม' });
  }

  const defaultColor = color_code || '#94a3b8'; 

  const sql = "INSERT INTO activity_types (type_name, color_code) VALUES (?, ?)";
  
  db.query(sql, [type_name, defaultColor], (err, result) => {
    if (err) {
      console.error('❌ เพิ่มประเภทกิจกรรมไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'เพิ่มข้อมูลไม่สำเร็จ' });
    }
    res.status(201).json({ 
      message: 'เพิ่มประเภทกิจกรรมสำเร็จ', 
      type_id: result.insertId 
    });
  });
});

app.put('/activity_types/:id', (req, res) => {
  const { id } = req.params;
  const { type_name, color_code } = req.body;

  if (!type_name) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อประเภทกิจกรรม' });
  }

  const sql = "UPDATE activity_types SET type_name = ?, color_code = ? WHERE type_id = ?";
  db.query(sql, [type_name, color_code, id], (err, result) => {
    if (err) {
      console.error('❌ แก้ไขประเภทกิจกรรมไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'แก้ไขข้อมูลไม่สำเร็จ' });
    }
    res.json({ message: 'อัปเดตประเภทกิจกรรมสำเร็จ' });
  });
});

app.delete('/activity_types/:id', (req, res) => {
  const { id } = req.params;

  const sql = "DELETE FROM activity_types WHERE type_id = ?";
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error('❌ ลบประเภทกิจกรรมไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ลบข้อมูลไม่สำเร็จ' });
    }
    res.json({ message: 'ลบประเภทกิจกรรมสำเร็จ' });
  });
});

app.get('/subjects', (req, res) => {
  const { year_id } = req.query;
  let sql = "SELECT * FROM subjects";
  let params = [];

  if (year_id) {
    sql += " WHERE year_id = ?";
    params.push(year_id);
  }

  sql += " ORDER BY subject_code ASC, section ASC";
  
  db.query(sql, params, (err, results) => {
    if (err) {
      console.error('❌ ดึงข้อมูลรายวิชาไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ดึงข้อมูลวิชาไม่สำเร็จ' });
    }
    res.json(results);
  });
});

app.post('/subjects', (req, res) => {
  const { subject_code, subject_name, section, day_of_week, start_time, end_time, room, instructor_name, year_id } = req.body;
  
  if (!subject_code || !subject_name) {
    return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อวิชาให้ครบถ้วน' });
  }

  const sql = `
    INSERT INTO subjects 
    (subject_code, subject_name, section, day_of_week, start_time, end_time, room, instructor_name, year_id) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  
  const values = [subject_code, subject_name, section, day_of_week, start_time || null, end_time || null, room, instructor_name, year_id || null];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('❌ เพิ่มรายวิชาไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'เพิ่มข้อมูลวิชาไม่สำเร็จ' });
    }
    res.status(201).json({ message: 'เพิ่มรายวิชาสำเร็จ', subject_id: result.insertId });
  });
});

app.put('/subjects/:id', (req, res) => {
  const { id } = req.params;
  const { subject_code, subject_name, section, day_of_week, start_time, end_time, room, instructor_name, year_id } = req.body;

  const sql = `
    UPDATE subjects 
    SET subject_code = ?, subject_name = ?, section = ?, day_of_week = ?, start_time = ?, end_time = ?, room = ?, instructor_name = ?, year_id = ?
    WHERE subject_id = ?
  `;
  
  const values = [subject_code, subject_name, section, day_of_week, start_time || null, end_time || null, room, instructor_name, year_id || null, id];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('❌ แก้ไขรายวิชาไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'แก้ไขข้อมูลวิชาไม่สำเร็จ' });
    }
    res.json({ message: 'อัปเดตข้อมูลรายวิชาสำเร็จ' });
  });
});

app.delete('/subjects/:id', (req, res) => {
  const { id } = req.params;

  const sql = "DELETE FROM subjects WHERE subject_id = ?";
  
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error('❌ ลบรายวิชาไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ลบรายวิชาไม่สำเร็จ' });
    }
    res.json({ message: 'ลบรายวิชาสำเร็จ' });
  });
});

app.get('/user-subjects', (req, res) => {
  const { email } = req.query;
  const sql = `
    SELECT us.id AS enroll_id, s.subject_id, s.subject_code, s.subject_name, 
           s.section, s.day_of_week, s.start_time, s.end_time, s.room, s.instructor_name
    FROM user_subjects us
    JOIN users u ON us.user_id = u.user_id
    JOIN subjects s ON us.subject_id = s.subject_id
    WHERE u.email = ?
  `;
  db.query(sql, [email], (err, results) => {
    if (err) {
      console.error('❌ ดึงข้อมูลตารางเรียนไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ดึงข้อมูลไม่สำเร็จ' });
    }
    res.json(results);
  });
});

app.post('/user-subjects', (req, res) => {
  const { email, subject_id } = req.body;
  const sql = `
    INSERT INTO user_subjects (user_id, subject_id) 
    VALUES ((SELECT user_id FROM users WHERE email = ? LIMIT 1), ?)
  `;
  db.query(sql, [email, subject_id], (err, result) => {
    if (err) {
      console.error('❌ เพิ่มวิชาเข้าตารางไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'เพิ่มข้อมูลไม่สำเร็จ' });
    }
    res.status(201).json({ message: 'เพิ่มวิชาสำเร็จ', enroll_id: result.insertId });
  });
});

app.delete('/user-subjects/:id', (req, res) => {
  const { id } = req.params;
  const sql = "DELETE FROM user_subjects WHERE id = ?";
  db.query(sql, [id], (err, result) => {
    if (err) return res.status(500).json({ error: 'ลบข้อมูลไม่สำเร็จ' });
    res.json({ message: 'ลบวิชาออกจากตารางสำเร็จ' });
  });
});

app.get('/academic-years', (req, res) => {
  const sql = 'SELECT * FROM academic_years ORDER BY academic_year DESC';
  db.query(sql, (err, results) => {
    if (err) {
      console.error('❌ ดึงข้อมูลปีการศึกษาไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ดึงข้อมูลปีการศึกษาล้มเหลว' });
    }
    res.json(results);
  });
});

app.post('/academic-years', (req, res) => {
  const { academic_year, set_as_current } = req.body;

  if (!academic_year) {
    return res.status(400).json({ error: 'กรุณาระบุปีการศึกษา' });
  }

  const insertYear = () => {
    const sql = 'INSERT INTO academic_years (academic_year, is_current) VALUES (?, ?)';
    db.query(sql, [academic_year, set_as_current || false], (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ error: 'ปีการศึกษานี้มีอยู่ในระบบแล้ว' });
        }
        console.error('❌ เพิ่มปีการศึกษาไม่สำเร็จ:', err);
        return res.status(500).json({ error: 'ไม่สามารถเพิ่มปีการศึกษาได้' });
      }
      res.status(201).json({ message: 'เพิ่มปีการศึกษาสำเร็จ', year_id: result.insertId });
    });
  };

  if (set_as_current) {
    db.query('UPDATE academic_years SET is_current = FALSE', (err) => {
      if (err) {
        console.error('❌ อัปเดตปีปัจจุบันไม่สำเร็จ:', err);
        return res.status(500).json({ error: 'อัปเดตปีการศึกษาล้มเหลว' });
      }
      insertYear();
    });
  } else {
    insertYear();
  }
});

cron.schedule('* * * * *', () => {
  const sql = `
    SELECT a.activity_id, a.title, a.location, u.push_token
    FROM activities a
    JOIN users u ON a.user_id = u.user_id
    WHERE a.is_notified = 0 
      AND u.push_token IS NOT NULL 
      AND u.push_token != ''
      AND TIMESTAMP(a.activity_date, a.start_time) - INTERVAL COALESCE(a.reminder_minutes, 0) MINUTE <= NOW()
      AND TIMESTAMP(a.activity_date, a.start_time) >= NOW() - INTERVAL 1 DAY
  `;

  db.query(sql, async (err, results) => {
    if (err) {
      console.error('❌ เกิดข้อผิดพลาดในการตรวจสอบเวลาแจ้งเตือน:', err);
      return;
    }

    if (results.length === 0) return;

    let messages = [];
    let activityIds = [];

    for (let item of results) {
      if (!Expo.isExpoPushToken(item.push_token)) {
        console.error(`⚠️ Token ไม่ถูกต้อง: ${item.push_token}`);
        continue;
      }

      messages.push({
        to: item.push_token,
        sound: 'default',
        title: '🔔 แจ้งเตือนกิจกรรม',
        body: `อีกไม่นานจะถึงเวลา: ${item.title}${item.location ? ` ที่ ${item.location}` : ''}`,
        data: { activityId: item.activity_id },
      });

      activityIds.push(item.activity_id);
    }

    let chunks = expo.chunkPushNotifications(messages);
    for (let chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
        console.log(`🚀 ส่งแจ้งเตือนสำเร็จจำนวน ${messages.length} รายการ`);
      } catch (error) {
        console.error('❌ เกิดข้อผิดพลาดตอนยิง Push:', error);
      }
    }

    if (activityIds.length > 0) {
      const updateSql = `UPDATE activities SET is_notified = 1 WHERE activity_id IN (?)`;
      db.query(updateSql, [activityIds], (updateErr) => {
        if (updateErr) console.error('❌ อัปเดตสถานะ is_notified ล้มเหลว:', updateErr);
      });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 Server กำลังรันอยู่ที่พอร์ต ${port}`);
});