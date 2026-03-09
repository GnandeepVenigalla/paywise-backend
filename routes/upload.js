/**
 * Upload routes – handles image uploads to OCI Object Storage
 * 
 * POST /api/upload/profile      – profile picture for the logged-in user
 * POST /api/upload/group/:id    – avatar for a specific group
 * POST /api/upload/bill/:expenseId – receipt/bill image for an expense
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const { uploadToOCI, deleteFromOCI, objectNameFromUrl } = require('../utils/ociStorage');
const User = require('../models/User');
const Group = require('../models/Group');
const Expense = require('../models/Expense');

// ── Multer config: memory storage (no disk writes) ──────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files (JPEG, PNG, WEBP, GIF, HEIC) are allowed.'));
        }
    },
});

// ── POST /api/upload/profile ──────────────────────────────────────
// Uploads a profile picture for the currently logged-in user
router.post('/profile', auth, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'No image provided.' });

        const userId = req.user.id;
        const ext = req.file.originalname.split('.').pop() || 'jpg';
        const objectName = `profiles/${userId}.${ext}`;

        // Delete old profile pic if it exists
        const user = await User.findById(userId);
        if (user.profilePic) {
            const oldName = objectNameFromUrl(user.profilePic);
            if (oldName) await deleteFromOCI(oldName);
        }

        const url = await uploadToOCI(req.file.buffer, objectName, req.file.mimetype);

        // Save URL to User model
        user.profilePic = url;
        await user.save();

        res.json({ url, msg: 'Profile picture updated.' });
    } catch (err) {
        console.error('[upload/profile]', err.message);
        res.status(500).json({ msg: err.message || 'Upload failed.' });
    }
});

// ── POST /api/upload/group/:id ─────────────────────────────────────
// Uploads a group avatar image
router.post('/group/:id', auth, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'No image provided.' });

        const groupId = req.params.id;
        const group = await Group.findById(groupId);
        if (!group) return res.status(404).json({ msg: 'Group not found.' });

        // Only group members can upload
        const isMember = group.members.some(m => String(m._id || m) === req.user.id);
        if (!isMember) return res.status(403).json({ msg: 'Not a member of this group.' });

        const ext = req.file.originalname.split('.').pop() || 'jpg';
        const objectName = `groups/${groupId}.${ext}`;

        // Delete old group image
        if (group.image) {
            const oldName = objectNameFromUrl(group.image);
            if (oldName) await deleteFromOCI(oldName);
        }

        const url = await uploadToOCI(req.file.buffer, objectName, req.file.mimetype);

        group.image = url;
        await group.save();

        res.json({ url, msg: 'Group image updated.' });
    } catch (err) {
        console.error('[upload/group]', err.message);
        res.status(500).json({ msg: err.message || 'Upload failed.' });
    }
});

// ── POST /api/upload/bill/:expenseId ──────────────────────────────
// Uploads a bill/receipt image for a specific expense
router.post('/bill/:expenseId', auth, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'No image provided.' });

        const expenseId = req.params.expenseId;
        const expense = await Expense.findById(expenseId);
        if (!expense) return res.status(404).json({ msg: 'Expense not found.' });

        const ext = req.file.originalname.split('.').pop() || 'jpg';
        // Use timestamp to allow multiple bill images per expense if needed
        const objectName = `bills/${expenseId}_${Date.now()}.${ext}`;

        // Delete previous bill image if exists
        if (expense.billImage) {
            const oldName = objectNameFromUrl(expense.billImage);
            if (oldName) await deleteFromOCI(oldName);
        }

        const url = await uploadToOCI(req.file.buffer, objectName, req.file.mimetype);

        expense.billImage = url;
        await expense.save();

        res.json({ url, msg: 'Bill image uploaded.' });
    } catch (err) {
        console.error('[upload/bill]', err.message);
        res.status(500).json({ msg: err.message || 'Upload failed.' });
    }
});

// ── POST /api/upload/bill-raw ───────────────────────────────────────
// Uploads a raw bill image without linking to an expense (for scan-then-create flow)
router.post('/bill-raw', auth, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'No image provided.' });

        const ext = req.file.originalname.split('.').pop() || 'jpg';
        const objectName = `bills/raw_${req.user.id}_${Date.now()}.${ext}`;
        const url = await uploadToOCI(req.file.buffer, objectName, req.file.mimetype);

        res.json({ url, objectName, msg: 'Bill image uploaded.' });
    } catch (err) {
        console.error('[upload/bill-raw]', err.message);
        res.status(500).json({ msg: err.message || 'Upload failed.' });
    }
});

module.exports = router;
