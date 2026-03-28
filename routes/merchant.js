const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Merchant = require('../models/Merchant');
const Katha = require('../models/Katha');
const User = require('../models/User');

// ─────────────────────────────────────────────
// MERCHANT ACCOUNT ENDPOINTS
// ─────────────────────────────────────────────

// GET /api/merchant/profile  → get the logged-in user's merchant profile
router.get('/profile', auth, async (req, res) => {
    try {
        const merchant = await Merchant.findOne({ user: req.user.id }).populate('user', 'username email phone');
        if (!merchant) return res.status(404).json({ msg: 'no-profile' });
        res.json(merchant);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// POST /api/merchant/onboard  → create or update merchant profile
router.post('/onboard', auth, async (req, res) => {
    const { shopName, category, whatsappNumber, storeAddress, upiId, shopPhoto, location } = req.body;
    try {
        let merchant = await Merchant.findOne({ user: req.user.id });
        if (merchant) {
            if (shopName) merchant.shopName = shopName;
            if (category) merchant.category = category;
            if (whatsappNumber) merchant.whatsappNumber = whatsappNumber;
            if (storeAddress) merchant.storeAddress = storeAddress;
            if (upiId) merchant.upiId = upiId;
            if (shopPhoto) merchant.shopPhoto = shopPhoto;
            if (location) merchant.location = location;
            await merchant.save();
            return res.json(merchant);
        }
        const crypto = require('crypto');
        const merchant_id = 'M_' + crypto.randomBytes(4).toString('hex').toUpperCase();
        merchant = new Merchant({
            user: req.user.id, shopName, category, whatsappNumber,
            storeAddress, upiId, shopPhoto, location,
            merchant_id, qrCode: `paywise://merchant/${merchant_id}`
        });
        await merchant.save();
        res.json(merchant);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// PUT /api/merchant/settings  → update merchant settings
router.put('/settings', auth, async (req, res) => {
    try {
        let merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant) return res.status(404).json({ msg: 'Merchant profile not found' });
        const { requireCustomerApproval, lockTransactionsAfterMinutes, freezesOnDispute, monthlyTarget } = req.body;
        if (typeof requireCustomerApproval !== 'undefined') merchant.requireCustomerApproval = requireCustomerApproval;
        if (lockTransactionsAfterMinutes) merchant.lockTransactionsAfterMinutes = lockTransactionsAfterMinutes;
        if (typeof freezesOnDispute !== 'undefined') merchant.freezesOnDispute = freezesOnDispute;
        if (typeof monthlyTarget !== 'undefined') merchant.monthlyTarget = monthlyTarget;
        await merchant.save();
        res.json(merchant);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// GET /api/merchant/trust-score  → get merchant's trust score
router.get('/trust-score', auth, async (req, res) => {
    try {
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant) return res.status(404).json({ msg: 'Merchant profile not found' });
        const totalEntries = await Katha.countDocuments({ merchant: merchant._id });
        const disputedEntries = await Katha.countDocuments({ merchant: merchant._id, status: 'DISPUTED' });
        let score = 100;
        if (totalEntries > 0) score = Math.max(0, Math.round(((totalEntries - disputedEntries) / totalEntries) * 100));
        res.json({ trustScore: score });
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// ─────────────────────────────────────────────
// MERCHANT CUSTOMER MANAGEMENT
// ─────────────────────────────────────────────

// GET /api/merchant/customers  → list all customers with aggregate balances
router.get('/customers', auth, async (req, res) => {
    try {
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant) return res.status(404).json({ msg: 'Merchant profile not found' });

        const entries = await Katha.find({ merchant: merchant._id });
        const customerMap = {};
        entries.forEach(entry => {
            const key = entry.customerPhone;
            if (!customerMap[key]) {
                customerMap[key] = {
                    name: entry.customerName,
                    phone: entry.customerPhone,
                    customerId: entry.customer,
                    balance: 0,
                    totalUdhar: 0,
                    totalJama: 0,
                    entryCount: 0,
                    lastTransaction: entry.createdAt,
                };
            }
            if (entry.approvalStatus === 'REJECTED') return;
            // Only count ACCEPTED entries towards official balance
            // PENDING entries will be shown in the history but not yet deducted
            const isOfficial = entry.approvalStatus === 'ACCEPTED' || !entry.approvalStatus;

            if (entry.entryType === 'UDHAR') {
                if (isOfficial) {
                    customerMap[key].balance += entry.amount;
                    customerMap[key].totalUdhar += entry.amount;
                }
            } else {
                if (isOfficial) {
                    customerMap[key].balance -= entry.amount;
                    customerMap[key].totalJama += entry.amount;
                }
            }
            customerMap[key].entryCount++;
            if (new Date(entry.createdAt) > new Date(customerMap[key].lastTransaction)) {
                customerMap[key].lastTransaction = entry.createdAt;
            }
        });
        res.json(Object.values(customerMap));
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// GET /api/merchant/customer/:phone/katha  → get all katha entries for one customer
router.get('/customer/:phone/katha', auth, async (req, res) => {
    try {
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant) return res.status(404).json({ msg: 'Merchant profile not found' });
        const entries = await Katha.find({
            merchant: merchant._id,
            customerPhone: req.params.phone
        }).sort({ createdAt: -1 });
        res.json(entries);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// ─────────────────────────────────────────────
// KATHA ENTRY CRUD (MERCHANT SIDE)
// ─────────────────────────────────────────────

// GET /api/merchant/katha  → all entries for this merchant
router.get('/katha', auth, async (req, res) => {
    try {
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant) return res.status(404).json({ msg: 'Merchant profile not found' });
        const entries = await Katha.find({ merchant: merchant._id }).sort({ createdAt: -1 });
        res.json(entries);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// POST /api/merchant/katha  → add a katha entry (UDHAR or JAMA)
router.post('/katha', auth, async (req, res) => {
    const { customerPhone, customerName, amount, entryType, description, itemList, isCorrection, originalEntryId } = req.body;
    try {
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant) return res.status(404).json({ msg: 'Merchant profile not found' });
        if (merchant.isFrozen && entryType === 'UDHAR') {
            return res.status(403).json({ msg: 'Merchant is frozen due to an active dispute.' });
        }
        // Fuzzy phone match for linked Paywise user
        const phone = String(customerPhone).replace(/\D/g, '').slice(-10);
        const customerUser = await User.findOne({ phone: { $regex: phone + '$' } });

        const newEntry = new Katha({
            merchant: merchant._id,
            customer: customerUser ? customerUser._id : null,
            customerName,
            customerPhone,
            amount,
            entryType,
            description: description || '',
            itemList: itemList || [],
            isCorrection: isCorrection || false,
            originalEntry: originalEntryId || null,
            approvalStatus: 'ACCEPTED',
        });
        await newEntry.save();
        res.json(newEntry);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// PUT /api/merchant/katha/:id  → edit within lock window
router.put('/katha/:id', auth, async (req, res) => {
    try {
        const entry = await Katha.findById(req.params.id);
        if (!entry) return res.status(404).json({ msg: 'Entry not found' });
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant || entry.merchant.toString() !== merchant._id.toString())
            return res.status(401).json({ msg: 'Unauthorized' });
        const diffMin = (Date.now() - new Date(entry.createdAt)) / 60000;
        if (entry.status !== 'DISPUTED' && diffMin > (merchant.lockTransactionsAfterMinutes || 5))
            return res.status(400).json({ msg: 'Entry is locked. Create a correction entry instead.' });
        const { amount, entryType, description, itemList } = req.body;
        if (amount !== undefined) entry.amount = amount;
        if (entryType) entry.entryType = entryType;
        if (description !== undefined) entry.description = description;
        if (itemList) entry.itemList = itemList;
        await entry.save();
        res.json(entry);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// POST /api/merchant/katha/:id/resolve  → merchant resolves a dispute
router.post('/katha/:id/resolve', auth, async (req, res) => {
    try {
        const { reply, action } = req.body; // action: 'RESOLVE' | 'DISMISS'
        const entry = await Katha.findById(req.params.id);
        if (!entry) return res.status(404).json({ msg: 'Entry not found' });
        
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant || entry.merchant.toString() !== merchant._id.toString())
            return res.status(401).json({ msg: 'Unauthorized' });

        entry.merchantReply = reply || '';
        if (action === 'RESOLVE') {
            entry.status = 'LOCKED'; // Back to locked/settled state
            // Unfreeze merchant if they were frozen
            if (merchant.isFrozen) {
                // check if any other active disputes
                const activeDisputes = await Katha.find({ merchant: merchant._id, status: 'DISPUTED' });
                if (activeDisputes.length <= 1) { // this one is current
                    merchant.isFrozen = false;
                    await merchant.save();
                }
            }
        }
        await entry.save();
        res.json({ msg: 'Dispute resolved.', entry });
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// DELETE /api/merchant/katha/:id  → delete within lock window
router.delete('/katha/:id', auth, async (req, res) => {
    try {
        const entry = await Katha.findById(req.params.id);
        if (!entry) return res.status(404).json({ msg: 'Entry not found' });
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant || entry.merchant.toString() !== merchant._id.toString())
            return res.status(401).json({ msg: 'Unauthorized' });
        const diffMin = (Date.now() - new Date(entry.createdAt)) / 60000;
        if (diffMin > (merchant.lockTransactionsAfterMinutes || 5))
            return res.status(400).json({ msg: 'Entry is locked and cannot be deleted.' });
        await entry.deleteOne();
        res.json({ msg: 'Entry removed' });
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// ─────────────────────────────────────────────
// BULK IMPORT (MERCHANT SIDE)
// ─────────────────────────────────────────────

// POST /api/merchant/bulk-import  → import rows from parsed CSV
router.post('/bulk-import', auth, async (req, res) => {
    try {
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant) return res.status(404).json({ msg: 'Merchant profile not found' });
        const { rows } = req.body;
        if (!rows || !Array.isArray(rows)) return res.status(400).json({ msg: 'rows[] required' });

        const imported = [], errors = [];
        for (const row of rows) {
            try {
                const { customerPhone, customerName, amount, entryType, description, date } = row;
                if (!customerPhone || !amount || !entryType) { errors.push({ row, reason: 'Missing fields' }); continue; }
                const phone = String(customerPhone).replace(/\D/g, '').slice(-10);
                const customerUser = await User.findOne({ phone: { $regex: phone + '$' } });
                const entry = new Katha({
                    merchant: merchant._id,
                    customer: customerUser ? customerUser._id : null,
                    customerName: customerName || 'Unknown',
                    customerPhone,
                    amount: parseFloat(amount),
                    entryType: String(entryType).toUpperCase(),
                    description: description || '',
                    date: date ? new Date(date) : new Date(),
                    approvalStatus: 'ACCEPTED',
                });
                await entry.save();
                imported.push(entry);
            } catch (e) { errors.push({ row, reason: e.message }); }
        }
        res.json({ imported, errors });
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// GET /api/merchant/bulk-template  → download CSV template
router.get('/bulk-template', auth, (req, res) => {
    const csv = `customerPhone,customerName,amount,entryType,description,date\n9876543210,Ramesh Kumar,500,UDHAR,Monthly groceries,2026-03-01\n9876543210,Ramesh Kumar,200,JAMA,Partial payment,2026-03-10\n8765432109,Sunderamma,350,UDHAR,Vegetables,2026-03-05`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="katha_import_template.csv"');
    res.send(csv);
});

// ─────────────────────────────────────────────
// USER-SIDE KATHA ENDPOINTS (Paywise Frontend)
// ─────────────────────────────────────────────

// GET /api/merchant/my-stores  → get all stores where logged-in user has active katha
router.get('/my-stores', auth, async (req, res) => {
    try {
        // All katha entries linked to this Paywise user
        const entries = await Katha.find({ customer: req.user.id })
            .populate({ path: 'merchant', populate: { path: 'user', select: 'username email' } });

        const merchantMap = {};
        for (const entry of entries) {
            if (!entry.merchant) continue;
            const mId = entry.merchant._id.toString();
            if (!merchantMap[mId]) {
                merchantMap[mId] = {
                    merchantId: mId,
                    merchant_id: entry.merchant.merchant_id,
                    shopName: entry.merchant.shopName,
                    category: entry.merchant.category,
                    whatsappNumber: entry.merchant.whatsappNumber,
                    upiId: entry.merchant.upiId,
                    balance: 0,        // positive = user owes store; negative = store owes user
                    totalUdhar: 0,
                    totalJama: 0,
                    lastTransaction: entry.createdAt,
                    entryCount: 0,
                    trustScore: 100,
                };
            }
            if (entry.approvalStatus === 'REJECTED' || entry.approvalStatus === 'PENDING') continue;

            // UDHAR from merchant = customer (user) took on credit → user owes → balance positive
            if (entry.entryType === 'UDHAR') {
                merchantMap[mId].balance += entry.amount;
                merchantMap[mId].totalUdhar += entry.amount;
            } else {
                merchantMap[mId].balance -= entry.amount;
                merchantMap[mId].totalJama += entry.amount;
            }
            merchantMap[mId].entryCount++;
            if (new Date(entry.createdAt) > new Date(merchantMap[mId].lastTransaction)) {
                merchantMap[mId].lastTransaction = entry.createdAt;
            }
        }

        // Compute trust scores
        for (const mId of Object.keys(merchantMap)) {
            const total = await Katha.countDocuments({ merchant: mId });
            const disputed = await Katha.countDocuments({ merchant: mId, status: 'DISPUTED' });
            merchantMap[mId].trustScore = total > 0 ? Math.max(0, Math.round(((total - disputed) / total) * 100)) : 100;
        }

        // Only stores with non-zero balance
        const result = Object.values(merchantMap).filter(m => m.balance !== 0);
        res.json(result);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// GET /api/merchant/:merchantId/my-katha  → user's own katha history with a specific store
router.get('/:merchantId/my-katha', auth, async (req, res) => {
    try {
        const entries = await Katha.find({
            merchant: req.params.merchantId,
            customer: req.user.id
        }).sort({ createdAt: -1 });
        res.json(entries);
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// ─────────────────────────────────────────────
// DISPUTE
// ─────────────────────────────────────────────

// POST /api/merchant/dispute/:id  → user raises a dispute on an entry
router.post('/dispute/:id', auth, async (req, res) => {
    try {
        const entry = await Katha.findById(req.params.id);
        if (!entry) return res.status(404).json({ msg: 'Entry not found' });
        entry.status = 'DISPUTED';
        entry.disputeReason = req.body.reason || 'No reason provided';
        await entry.save();
        const merchant = await Merchant.findById(entry.merchant);
        if (merchant && merchant.freezesOnDispute) { merchant.isFrozen = true; await merchant.save(); }
        res.json({ msg: 'Dispute raised.' });
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// POST /api/merchant/:merchantId/record-cash  → user records that they paid in cash
router.post('/:merchantId/record-cash', auth, async (req, res) => {
    try {
        const { amount, description } = req.body;
        const entry = new Katha({
            merchant: req.params.merchantId,
            customer: req.user.id,
            customerName: req.user.name,
            customerPhone: req.user.phone,
            amount: parseFloat(amount),
            entryType: 'JAMA',
            description: description || 'Cash payment reported by user',
            approvalStatus: 'PENDING',
            status: 'PENDING_APPROVAL'
        });
        await entry.save();
        res.json({ msg: 'Cash record submitted for merchant approval.' });
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

// POST /api/merchant/approve-entry/:id  → merchant approves a user-recorded entry
router.post('/approve-entry/:id', auth, async (req, res) => {
    try {
        const { action } = req.body; // 'ACCEPT' or 'REJECT'
        const entry = await Katha.findById(req.params.id);
        if (!entry) return res.status(404).json({ msg: 'Entry not found' });
        
        const merchant = await Merchant.findOne({ user: req.user.id });
        if (!merchant || entry.merchant.toString() !== merchant._id.toString())
            return res.status(401).json({ msg: 'Unauthorized' });

        if (action === 'ACCEPT') {
            entry.approvalStatus = 'ACCEPTED';
            entry.status = 'LOCKED';
        } else {
            entry.approvalStatus = 'REJECTED';
            // We keep it in DB but it won't count towards balance usually if logic follows that
            // Actually, balance calculation should check approvalStatus
        }
        await entry.save();
        res.json({ msg: `Entry ${action === 'ACCEPT' ? 'approved' : 'rejected'}.` });
    } catch (err) { console.error(err.message); res.status(500).send('Server error'); }
});

module.exports = router;
