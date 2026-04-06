const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const Report = require('../models/Report');
const auth = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');
const logActivity = require('../utils/activityLogger');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// @route   POST api/auth/google
// @desc    Sign in / sign up via Google OAuth (Google One Tap / OAuth button)
router.post('/google', async (req, res) => {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ msg: 'Google credential required' });

    try {
        // Verify the ID token with Google
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        const { sub: googleId, email, name, picture } = payload;

        let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });

        if (user) {
            // Link Google ID if not already linked (existing email account)
            if (!user.googleId) {
                user.googleId = googleId;
                user.authProvider = 'google';
                if (picture && !user.profilePic) user.profilePic = picture;
                await user.save();
            }

            if (!user.isVerified) {
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
                user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
                await user.save();

                const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
                await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

                return res.json({ msg: 'Please verify your email address. A code was sent.', requireOtp: true, email: user.email });
            }
        } else {
            let defaultCurrency = 'USD';
            try {
                const { default: axios } = require('axios');
                // Use a more reliable geolocation source for registration
                const loc = await axios.get('https://ipapi.co/json/', { timeout: 3000 });
                if (loc.data?.currency) defaultCurrency = loc.data.currency.toUpperCase();
            } catch (_) {}

            // Generate a unique username from their Google name
            let baseUsername = (name || email.split('@')[0]).replace(/[^a-zA-Z0-9_]/g, '').substring(0, 20);
            let username = baseUsername;
            let suffix = 1;
            while (await User.findOne({ username })) {
                username = `${baseUsername}${suffix++}`;
            }

            user = new User({
                username,
                email: email.toLowerCase(),
                googleId,
                authProvider: 'google',
                profilePic: picture || null,
                isVerified: false,
                defaultCurrency,
                timezone: req.body.timezone || 'UTC',
                password: crypto.randomBytes(32).toString('hex')  // random unusable password
            });
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
            user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
            await user.save();

            // Track analytics
            try { const t = require('../utils/analyticsTracker'); await t('visits', 1); } catch(_) {}
        }

        // Check if phone number is missing (for Google users)
        if (!user.phone) {
            const { createNotification } = require('../utils/notificationService');
            // Try to avoid spamming by checking if a similar notification was sent recently? 
            // For now, per user request, we send it.
            createNotification({
                recipientId: user.id,
                title: 'Phone Number Required',
                message: 'Please update your phone number in Account Settings to enable full security and friend features.',
                category: 'system',
                actionUrl: '/account'
            }).catch(e => console.error('Phone notification error:', e.message));

            sendEmail({
                email: user.email,
                subject: 'Action Required: Update your Paywise phone number',
                message: `Hi ${user.username},\n\nWelcome to Paywise! We noticed your account is missing a phone number.\n\nAdding a phone number helps your friends find you easily and keeps your account secure.\n\nPlease update it here: ${process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#/account'}\n\nHappy splitting!`
            }).catch(e => console.error('Phone email error:', e.message));
        }

        // Issue JWT
        const jwtPayload = { user: { id: user.id } };
        const token = await new Promise((resolve, reject) => {
            jwt.sign(jwtPayload, process.env.JWT_SECRET || 'secret', { expiresIn: 360000 }, (err, t) => {
                if (err) reject(err); else resolve(t);
            });
        });

        res.json({
            token,
            user: { id: user.id, username: user.username, email: user.email }
        });
    } catch (err) {
        console.error('[Google Auth Error]', err.message);
        res.status(401).json({ msg: 'Invalid Google credential. Please try again.' });
    }
});

// @route   POST api/auth/google-token
// @desc    Sign in / sign up with Google user info (implicit flow — frontend fetches from Google userinfo)
router.post('/google-token', async (req, res) => {
    const { googleId, email, name, picture } = req.body;
    if (!googleId || !email) return res.status(400).json({ msg: 'Google user info required' });

    try {
        let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });

        if (user) {
            if (!user.googleId) {
                user.googleId = googleId;
                user.authProvider = 'google';
                if (picture && !user.profilePic) user.profilePic = picture;
                await user.save();
            }
            if (!user.isVerified) {
                const crypto = require('crypto');
                const sendEmail = require('../utils/sendEmail');
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
                user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
                await user.save();

                const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
                await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

                return res.json({ msg: 'Please verify your email address. A code was sent.', requireOtp: true, email: user.email });
            }
        } else {
            // New user — auto-register
            let defaultCurrency = 'USD';
            try {
                const { default: axios } = require('axios');
                const loc = await axios.get('http://ip-api.com/json/?fields=currency', { timeout: 3000 });
                if (loc.data?.currency?.length === 3) defaultCurrency = loc.data.currency.toUpperCase();
            } catch (_) {}

            const crypto = require('crypto');
            let baseUsername = (name || email.split('@')[0]).replace(/[^a-zA-Z0-9_]/g, '').substring(0, 20);
            let username = baseUsername;
            let suffix = 1;
            while (await User.findOne({ username })) {
                username = `${baseUsername}${suffix++}`;
            }

            user = new User({
                username,
                email: email.toLowerCase(),
                googleId,
                authProvider: 'google',
                profilePic: picture || null,
                isVerified: false,
                defaultCurrency,
                timezone: req.body.timezone || 'UTC',
                password: crypto.randomBytes(32).toString('hex')
            });
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
            user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
            await user.save();
            try { const t = require('../utils/analyticsTracker'); await t('visits', 1); } catch(_) {}

            const sendEmail = require('../utils/sendEmail');
            const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
            await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

            return res.json({ msg: 'Verification code sent to email', requireOtp: true, email: user.email });
        }

        // Check if phone number is missing
        if (!user.phone) {
            const { createNotification } = require('../utils/notificationService');
            createNotification({
                recipientId: user.id,
                title: 'Phone Number Required',
                message: 'Please update your phone number in Account Settings to enable full security and friend features.',
                category: 'system',
                actionUrl: '/account'
            }).catch(e => console.error('Phone notification error:', e.message));

            require('../utils/sendEmail')({
                email: user.email,
                subject: 'Action Required: Update your Paywise phone number',
                message: `Hi ${user.username},\n\nWe noticed your account is missing a phone number.\n\nAdding a phone number helps your friends find you easily and keeps your account secure.\n\nPlease update it here: ${process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#/account'}\n\nHappy splitting!`
            }).catch(e => console.error('Phone email error:', e.message));
        }

        const jwtPayload = { user: { id: user.id } };
        const token = await new Promise((resolve, reject) => {
            jwt.sign(jwtPayload, process.env.JWT_SECRET || 'secret', { expiresIn: 360000 }, (err, t) => {
                if (err) reject(err); else resolve(t);
            });
        });

        res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
    } catch (err) {
        console.error('[Google Token Auth Error]', err.message);
        res.status(500).json({ msg: 'Failed to sign in with Google. Please try again.' });
    }
});

// @route   POST api/auth/register
// @desc    Register user (promotes ghost accounts from Splitwise migration)
router.post('/register', async (req, res) => {
    let { username, email, phone, password, defaultCurrency, timezone } = req.body;
    if (email) email = email.toLowerCase();
    if (!username || !email || !phone || !password) {
        return res.status(400).json({ msg: 'Please enter all fields including phone number' });
    }
    try {
        let user = await User.findOne({ $or: [{ email }, { phone }] });

        if (user) {
            if (user.isGhostUser || !user.isVerified) {
                // If it's a ghost account or an unverified registration, allow "re-registering" / proceeding to OTP
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(password, salt);
                user.username = username;
                user.phone = phone;
                user.isVerified = false;
                if (user.isGhostUser) {
                    user.isGhostUser = false;
                    user.splitwiseMigrationStatus = 'none';
                    if (defaultCurrency) user.defaultCurrency = defaultCurrency;
                }

                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
                user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
                await user.save();

                const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
                await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

                return res.json({ msg: 'Verification code sent to email', requireOtp: true, email: user.email });
            }
            return res.status(400).json({ msg: 'User already exists and is verified' });
        }

        user = new User({ 
            username, email, phone, password, 
            isVerified: false, 
            defaultCurrency: defaultCurrency || 'USD',
            timezone: timezone || 'UTC'
        });
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
        user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
        await user.save();

        const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
        await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

        res.json({ msg: 'Verification code sent to email', requireOtp: true, email: user.email });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/login
// @desc    Authenticate user & get token
router.post('/login', async (req, res) => {
    let { email, password } = req.body;
    if (email) email = email.toLowerCase();
    try {
        let user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        // Guard: Google-only accounts don't have a usable password
        if (user.authProvider === 'google' && !user.password) {
            return res.status(400).json({ msg: 'This account uses Google Sign-In. Please use the "Continue with Google" button.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid Credentials' });
        }

        if (!user.isVerified) {
            // Generate and send a new OTP since they tried to log in but are unverified
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
            user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
            await user.save();
            const message = `Welcome to Paywise!\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
            await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

            return res.status(403).json({ msg: 'Please verify your email address. A new code was sent.', requireOtp: true, email: user.email });
        }

        if (!user.phone) {
            const { createNotification } = require('../utils/notificationService');
            createNotification({
                recipientId: user.id,
                title: 'Phone Number Required',
                message: 'Please update your phone number in Account Settings to help friends find you and keep your account secure.',
                category: 'system',
                actionUrl: '/account'
            }).catch(e => console.error('Phone notification error:', e.message));

            sendEmail({
                email: user.email,
                subject: 'Action Required: Update your Paywise phone number',
                message: `Hi ${user.username},\n\nWe noticed your account is missing a phone number.\n\nAdding a phone number helps your friends find you easily and keeps your account secure.\n\nPlease update it here: ${process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#/account'}\n\nHappy splitting!`
            }).catch(e => console.error('Phone email error:', e.message));
        }

        const payload = { user: { id: user.id } };
        jwt.sign(payload, process.env.JWT_SECRET || 'secret', { expiresIn: 360000 }, (err, token) => {
            if (err) throw err;
            res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/admin-login-otp
// @desc    Request OTP for passwordless admin login
router.post('/admin-login-otp', async (req, res) => {
    let { email } = req.body;
    if (email) email = email.toLowerCase();
    
    // Only allow @paywiseapp.com emails or the root admin
    if (!email || (!email.endsWith('@paywiseapp.com') && email !== 'nirvanasahu9@gmail.com')) {
        return res.status(403).json({ msg: 'Access denied. Valid @paywiseapp.com email required.' });
    }

    try {
        let user = await User.findOne({ email });
        
        // Gnandeep is the Super Super Admin (Root)
        const isRoot = email === 'gnandeep.venigalla@paywiseapp.com';

        if (isRoot) {
            if (!user) {
                // If user doesn't exist, create them as root
                user = new User({
                    username: 'Gnandeep',
                    email: email,
                    password: crypto.randomBytes(20).toString('hex'),
                    isVerified: true,
                    adminRole: 'root'
                });
            } else if (user.adminRole !== 'root') {
                // If they exist but don't have the root role, PROMOTE them
                user.adminRole = 'root';
            }
            await user.save();
        } else if (!user || !user.adminRole) {
            // If they are not root and don't have an admin role, they can't login
            return res.status(403).json({ msg: 'Unauthorized. You have not been added as an admin.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
        user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
        await user.save();

        const message = `Paywise Admin Access\n\nYour verification code is: ${otp}\n\nThis code is valid for 10 minutes. If you did not request this, please contact security.`;
        await sendEmail({ email: user.email, subject: 'Paywise Admin Verification Code', message });

        res.json({ msg: 'Verification code sent to email', requireOtp: true });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/verify-otp
// @desc    Verify OTP and return token
router.post('/verify-otp', async (req, res) => {
    let { email, otp } = req.body;
    if (email) email = email.toLowerCase();
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ msg: 'Invalid user' });

        const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');
        if (user.emailVerificationOtp !== hashedOtp || user.emailVerificationExpire < Date.now()) {
            return res.status(400).json({ msg: 'Invalid or expired verification code' });
        }

        user.emailVerificationOtp = undefined;
        user.emailVerificationExpire = undefined;
        user.lastActive = new Date();
        user.isVerified = true;
        await user.save();

        if (user.phone) {
            const Katha = require('../models/Katha');
            const phoneStr = String(user.phone).replace(/\D/g, '').slice(-10);
            if (phoneStr.length === 10) {
                const phoneMatchRegex = new RegExp(phoneStr + '$');
                await Katha.updateMany(
                    { customer: null, customerPhone: { $regex: phoneMatchRegex } },
                    { $set: { customer: user._id } }
                ).catch(err => console.error("Katha link error:", err));
            }
        }

        const trackMetric = require('../utils/analyticsTracker');
        await trackMetric('visits', 1);

        await logActivity({
            user: user._id,
            action: user.adminRole ? `Portal access granted: ${user.adminRole.toUpperCase()}` : 'Node connection established (Login)',
            category: user.adminRole ? 'system' : 'user',
            status: 'success'
        });

        if (!user.phone) {
            const { createNotification } = require('../utils/notificationService');
            createNotification({
                recipientId: user.id,
                title: 'Phone Number Required',
                message: 'Please update your phone number in Account Settings to help friends find you and keep your account secure.',
                category: 'system',
                actionUrl: '/account'
            }).catch(e => console.error('Phone notification error:', e.message));

            sendEmail({
                email: user.email,
                subject: 'Action Required: Update your Paywise phone number',
                message: `Hi ${user.username},\n\nWe noticed your account is missing a phone number.\n\nAdding a phone number helps your friends find you easily and keeps your account secure.\n\nPlease update it here: ${process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#/account'}\n\nHappy splitting!`
            }).catch(e => console.error('Phone email error:', e.message));
        }

        const payload = { user: { id: user.id } };
        jwt.sign(payload, process.env.JWT_SECRET || 'secret', { expiresIn: 360000 }, (err, token) => {
            if (err) throw err;
            res.json({ 
                token, 
                user: { 
                    id: user.id, 
                    username: user.username, 
                    email: user.email,
                    adminRole: user.adminRole 
                } 
            });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/resend-otp
// @desc    Resend verification OTP
router.post('/resend-otp', async (req, res) => {
    let { email } = req.body;
    if (email) email = email.toLowerCase();
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ msg: 'Invalid user' });
        if (user.isVerified) return res.status(400).json({ msg: 'User is already verified' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.emailVerificationOtp = crypto.createHash('sha256').update(otp).digest('hex');
        user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
        await user.save();

        const message = `Welcome to Paywise!\n\nYour new verification code is: ${otp}\n\nThis code is valid for 10 minutes.`;
        await sendEmail({ email: user.email, subject: 'Paywise Verification Code', message });

        res.json({ msg: 'Verification code resent successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/auth/me
// @desc    Get current user
router.get('/me', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        
        // Asynchronously update last active timestamp
        User.updateOne({ _id: user._id }, { $set: { lastActive: new Date() } }).exec().catch(err => console.error("Error updating lastActive:", err));

        // Map _id to id so frontend operations using user.id work correctly everywhere
        res.json({ ...user._doc, id: user._id });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   GET api/auth/users
// @desc    Search users by exact email or phone
router.get('/users', auth, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.json([]);
        }
        const safeQuery = query.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        const queryRegex = new RegExp(safeQuery, 'i');

        const rawPhone = query.replace(/\D/g, '');
        const phoneRegexStr = rawPhone.length > 0 ? rawPhone.split('').join('\\D*') : '^$';
        const phoneRegex = new RegExp(phoneRegexStr, 'i');

        const users = await User.find({
            $or: [
                { email: queryRegex },
                { username: queryRegex },
                { phone: queryRegex },
                { phone: phoneRegex },
                ...(rawPhone.length >= 10 ? [{ phone: new RegExp(rawPhone.slice(-10).split('').join('\\D*'), 'i') }] : [])
            ]
        }).select('-password').limit(10);
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/users/bulk
// @desc    Search multiple users by exact emails or phones
router.post('/users/bulk', auth, async (req, res) => {
    try {
        const { contacts } = req.body;
        if (!contacts || !Array.isArray(contacts)) {
            return res.json([]);
        }

        const emails = contacts.filter(c => c.includes('@'));
        const phones = contacts.filter(c => !c.includes('@'));

        const orConditions = [];
        if (emails.length > 0) {
            orConditions.push({ email: { $in: emails } });
        }
        
        if (phones.length > 0) {
            phones.forEach(p => {
                const rawPhone = p.replace(/\D/g, '');
                if (rawPhone.length >= 5) {
                    const r = new RegExp(rawPhone.split('').join('\\D*'), 'i');
                    orConditions.push({ phone: r });
                    
                    // Also try matching the last 10 digits as a fallback
                    if (rawPhone.length >= 10) {
                        const last10 = rawPhone.slice(-10);
                        orConditions.push({ phone: new RegExp(last10.split('').join('\\D*'), 'i') });
                    }
                }
            });
        }

        if (orConditions.length === 0) return res.json([]);

        const users = await User.find({ $or: orConditions }).select('-password');
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST api/auth/forgotpassword
// @desc    Send password reset email
router.post('/forgotpassword', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email });

        // No account found — tell the user clearly
        if (!user) {
            return res.status(404).json({
                msg: 'No Paywise account found with that email. Please register first.'
            });
        }

        // Google-only accounts have no password to reset
        if (user.authProvider === 'google' && !user.password) {
            return res.status(400).json({
                msg: 'This account uses Google Sign-In. Please log in with Google instead — no password is needed.'
            });
        }

        // Generate token
        const resetToken = crypto.randomBytes(20).toString('hex');

        // Hash token and set to resetPasswordToken field
        user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        // Set token expire time (10 minutes)
        user.resetPasswordExpire = Date.now() + 10 * 60 * 1000;
        await user.save();

        // Create reset url
        const baseUrl = process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#';
        const resetUrl = `${baseUrl}/resetpassword/${resetToken}`;

        const htmlEmail = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Reset Your Password — Paywise</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">Paywise</h1>
          <p style="margin:4px 0 0;color:#94a3b8;font-size:13px;">Smart Bill Splitting</p>
        </td></tr>
        <tr><td style="background:#fefce8;border-bottom:2px solid #fbbf2420;padding:24px 32px;text-align:center;">
          <span style="font-size:32px;">🔐</span>
          <p style="margin:8px 0 0;font-size:16px;font-weight:800;color:#b45309;text-transform:uppercase;letter-spacing:0.05em;">Password Reset</p>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 20px;font-size:16px;color:#374151;line-height:1.6;">
            Hi <strong>${user.username}</strong>,<br>
            We received a request to reset your Paywise password.
          </p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${resetUrl}" style="display:inline-block;background:#0f172a;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;">Reset My Password →</a>
          </div>
          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
            ⏱️ This link expires in <strong>10 minutes</strong>.
          </p>
          <p style="margin:0;font-size:13px;color:#6b7280;">
            If you didn't request this, you can safely ignore this email — your password won't change.
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;text-align:center;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            <a href="https://paywiseapp.com" style="color:#059669;text-decoration:none;">paywiseapp.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

        const plainText = `Hi ${user.username},\n\nWe received a request to reset your Paywise password.\n\nClick the link below to reset it (expires in 10 minutes):\n\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\n— The Paywise Team`;

        try {
            await sendEmail({
                email: user.email,
                subject: '🔐 Reset your Paywise password',
                message: plainText,
                html: htmlEmail,
            });
            res.status(200).json({ msg: 'Email sent' });
        } catch (err) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save();
            return res.status(500).json({ msg: 'Email could not be sent. Please try again later.' });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/resetpassword/:resettoken
// @desc    Reset password using token
router.put('/resetpassword/:resettoken', async (req, res) => {
    try {
        // Get hashed token
        const resetPasswordToken = crypto.createHash('sha256').update(req.params.resettoken).digest('hex');

        const user = await User.findOne({
            resetPasswordToken,
            resetPasswordExpire: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ msg: 'Invalid or expired token' });
        }

        // Set new password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(req.body.password, salt);

        // Clear reset tokens
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save();

        res.status(200).json({ msg: 'Password reset successful' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/invite
// @desc    Send a Paywise referral invite to an email
router.post('/invite', auth, async (req, res) => {
    try {
        const { email } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser && !existingUser.isGhostUser) {
            return res.status(400).json({ msg: 'This user already has a Paywise account!' });
        }

        const sender = await User.findById(req.user.id);

        const baseUrl = process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#';
        const message = `Hi there!\n\n${sender.username} has invited you to join Paywise.\n\nPaywise is the smartest way to split itemized bills and track group expenses along with your friends.\n\nSign up today to join them: ${baseUrl}/register\n\nWelcome to Paywise!`;

        await sendEmail({
            email,
            subject: `${sender.username} invited you to Paywise!`,
            message
        });

        res.status(200).json({ msg: 'Invitation email sent successfully!' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/auth/friends
// @desc    Get user's friends with their balances
router.get('/friends', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).populate('friends', 'username email');

        // Let's also compute the balance between the user and each friend
        // For each friend, find expenses where group is null and either user or friend paid, and the other is in splits
        const Expense = require('../models/Expense');

        const friendsWithBalances = await Promise.all(user.friends.map(async (friend) => {
            let expenses = await Expense.find({
                $or: [
                    { paidBy: user._id, 'splits.user': friend._id },
                    { paidBy: friend._id, 'splits.user': user._id }
                ]
            }).populate('group', 'name groupType');

            expenses = expenses.filter(exp => !(exp.group && exp.group.groupType === 'community'));


            const { convertAmount } = require('../utils/currency');

            // --- Detect dominant currency (mirrors /expenses/friends/:friendId logic) ---
            const currencyTotals = {};
            expenses.forEach(exp => {
                const c = (exp.currency || 'USD').toUpperCase();
                const isPaidByMe = exp.paidBy.toString() === user._id.toString();
                let splitAmt = 0;
                if (isPaidByMe) {
                    const fSplit = exp.splits.find(s => s.user.toString() === friend._id.toString());
                    if (fSplit) splitAmt = fSplit.amount;
                } else {
                    const mySplit = exp.splits.find(s => s.user.toString() === user._id.toString());
                    if (mySplit) splitAmt = mySplit.amount;
                }
                if (splitAmt > 0) currencyTotals[c] = (currencyTotals[c] || 0) + splitAmt;
            });

            const currencies = Object.keys(currencyTotals);
            // Single-currency pair (e.g. both INR): keep as-is. Mixed: normalise through USD.
            const dominantCurrency = currencies.length === 1 ? currencies[0] : 'USD';

            let balance = 0;
            expenses.forEach(exp => {
                const isPaidByMe = exp.paidBy.toString() === user._id.toString();
                const sourceCurr = (exp.currency || 'USD').toUpperCase();
                if (isPaidByMe) {
                    const friendSplit = exp.splits.find(s => s.user.toString() === friend._id.toString());
                    if (friendSplit)
                        balance += Math.round(convertAmount(friendSplit.amount, sourceCurr, dominantCurrency) * 100) / 100;
                } else {
                    const mySplit = exp.splits.find(s => s.user.toString() === user._id.toString());
                    if (mySplit)
                        balance -= Math.round(convertAmount(mySplit.amount, sourceCurr, dominantCurrency) * 100) / 100;
                }
            });

            balance = Math.round(balance * 100) / 100;

            // Phantom balance guard: tiny residuals from cross-currency rounding → snap to 0
            if (currencies.length > 1 && Math.abs(balance) < 0.50) {
                balance = 0;
            }

            return {
                _id: friend._id,
                id: friend._id,
                username: friend.username,
                email: friend.email,
                balance,
                balanceCurrency: dominantCurrency,
            };

        }));

        res.json(friendsWithBalances);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/friends
// @desc    Add a friend
router.post('/friends', auth, async (req, res) => {
    try {
        const { friendId } = req.body;
        if (friendId === req.user.id) {
            return res.status(400).json({ msg: "You can't add yourself as a friend." });
        }

        const user = await User.findById(req.user.id);
        const friend = await User.findById(friendId);

        if (!friend) {
            return res.status(404).json({ msg: 'User not found' });
        }

        // Check if user has blocked this person
        if (user.blockedUsers.includes(friendId)) {
            return res.status(400).json({ msg: 'You have blocked this user. Please unblock them first to add as a friend.' });
        }

        // Check if the other person has blocked us
        if (friend.blockedUsers.includes(req.user.id)) {
            return res.status(400).json({ msg: 'Unable to add friend at this time.' });
        }

        if (user.friends.includes(friendId)) {
            return res.status(400).json({ msg: 'User is already your friend' });
        }

        user.friends.push(friendId);
        friend.friends.push(user._id); // reciprocal friend

        await user.save();
        await friend.save();

        // In-app notification for the newly added friend
        const { createNotification } = require('../utils/notificationService');
        await createNotification({
            recipientId: friendId,
            title: `👋 New friend: ${user.username}`,
            message: `${user.username} added you as a friend on Paywise.`,
            category: 'friend',
            type: 'success',
            actionUrl: `/friends/${user._id.toString()}`,
            metadata: { friendId: user._id.toString() }
        });

        res.json({ msg: 'Friend added successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/notifications
// @desc    Update notification settings
router.put('/notifications', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.notificationSettings = {
            ...user.notificationSettings,
            ...req.body
        };

        await user.save();
        res.json(user.notificationSettings);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/profile
// @desc    Update user profile (username, email, phone)
router.put('/profile', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        const { username, email, phone } = req.body;
        
        let previousPhone = user.phone;
        
        // If email or phone changes, we should ideally verify, but for simple MVP let's just update
        if (username) user.username = username;
        if (email) {
            user.email = email.toLowerCase();
            // user.isVerified = false; // Add this if you want to force re-verification
        }
        if (phone) user.phone = phone;

        await user.save();
        
        // Link orphan Katha entries if phone number was added/updated
        if (phone && phone !== previousPhone) {
            const Katha = require('../models/Katha');
            const phoneStr = String(phone).replace(/\D/g, '').slice(-10);
            if (phoneStr.length === 10) {
                const phoneMatchRegex = new RegExp(phoneStr + '$');
                await Katha.updateMany(
                    { customer: null, customerPhone: { $regex: phoneMatchRegex } },
                    { $set: { customer: user._id } }
                ).catch(err => console.error("Katha link error:", err));
            }
        }
        
        // Return updated user object without password
        const updatedUser = await User.findById(req.user.id).select('-password');
        res.json({ ...updatedUser._doc, id: updatedUser._id });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ msg: 'Email or phone number already in use by another account.' });
        }
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/password
// @desc    Update user password
router.put('/password', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        const { currentPassword, newPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ msg: 'Please provide both current and new passwords' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Incorrect current password' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.json({ msg: 'Password updated successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/preferences
// @desc    Update user preferences (currency, timezone)
router.put('/preferences', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        if (req.body.defaultCurrency) user.defaultCurrency = req.body.defaultCurrency;
        if (req.body.timezone) user.timezone = req.body.timezone;

        await user.save();
        res.json({ defaultCurrency: user.defaultCurrency, timezone: user.timezone });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/app-settings
// @desc    Save all app settings (split method, budget, theme, customTheme, etc.)
router.put('/app-settings', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        const { customTheme, ...flatSettings } = req.body;

        // Merge flat settings (theme, language, etc.)
        Object.assign(user.appSettings, flatSettings);

        // Deep-merge customTheme if provided
        if (customTheme && typeof customTheme === 'object') {
            user.appSettings.customTheme = {
                ...((user.appSettings.customTheme || {}).toObject
                    ? user.appSettings.customTheme.toObject()
                    : user.appSettings.customTheme || {}),
                ...customTheme,
            };
        }

        // Mark sub-document as modified so Mongoose picks up the changes
        user.markModified('appSettings');

        await user.save();
        res.json(user.appSettings);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/auth/friend-note/:friendId
// @desc    Get the shared note between two friends (stored on both sides)
router.get('/friend-note/:friendId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const entry = user.friendNotes.find(n => n.friend.toString() === req.params.friendId);
        res.json({ note: entry ? entry.note : '' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/friend-note/:friendId
// @desc    Save/update the shared note for a friend (stored on both users)
router.put('/friend-note/:friendId', auth, async (req, res) => {
    try {
        const noteText = req.body.note || '';

        // Update on the current user's side
        const user = await User.findById(req.user.id);
        let entry = user.friendNotes.find(n => n.friend.toString() === req.params.friendId);
        if (entry) {
            entry.note = noteText;
        } else {
            user.friendNotes.push({ friend: req.params.friendId, note: noteText });
        }
        await user.save();

        // Mirror on the friend's side so they see it too
        const friend = await User.findById(req.params.friendId);
        if (friend) {
            let friendEntry = friend.friendNotes.find(n => n.friend.toString() === req.user.id);
            if (friendEntry) {
                friendEntry.note = noteText;
            } else {
                friend.friendNotes.push({ friend: req.user.id, note: noteText });
            }
            await friend.save();
        }

        res.json({ note: noteText });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/auth/friend-settings/:friendId
// @desc    Get interest settings for a friend
router.get('/friend-settings/:friendId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const setting = user.friendSettings.find(s => s.friend.toString() === req.params.friendId);
        res.json({
            interestRate: setting ? setting.interestRate : 0,
            interestEnabled: setting ? setting.interestEnabled : false
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/auth/friend-settings/:friendId
// @desc    Update interest settings for a friend
router.put('/friend-settings/:friendId', auth, async (req, res) => {
    try {
        const { interestRate, interestEnabled } = req.body;
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        let setting = user.friendSettings.find(s => s.friend.toString() === req.params.friendId);
        if (setting) {
            setting.interestRate = interestRate !== undefined ? interestRate : setting.interestRate;
            setting.interestEnabled = interestEnabled !== undefined ? interestEnabled : setting.interestEnabled;
            if (interestEnabled) setting.lastInterestApplied = new Date(); // Reset to today to start from tomorrow
        } else {
            user.friendSettings.push({
                friend: req.params.friendId,
                interestRate: interestRate || 0,
                interestEnabled: interestEnabled || false,
                lastInterestApplied: new Date()
            });
        }
        await user.save();
        res.json({ msg: 'Friend settings updated' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE api/auth/friends/:friendId
// @desc    Remove a friend (mutual — removes from both sides)
router.delete('/friends/:friendId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const friend = await User.findById(req.params.friendId);

        if (!friend) return res.status(404).json({ msg: 'User not found' });

        // Remove from both sides
        user.friends = user.friends.filter(f => f.toString() !== req.params.friendId);
        if (friend) {
            friend.friends = friend.friends.filter(f => f.toString() !== req.user.id);
            await friend.save();
        }
        await user.save();

        res.json({ msg: 'Friend removed successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/friends/block/:friendId
// @desc    Block a friend (removes as friend from both sides and adds to block list)
router.post('/friends/block/:friendId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const friend = await User.findById(req.params.friendId);

        if (!friend) return res.status(404).json({ msg: 'User not found' });

        // Remove from both sides
        user.friends = user.friends.filter(f => f.toString() !== req.params.friendId);
        if (friend) {
            friend.friends = friend.friends.filter(f => f.toString() !== req.user.id);
            await friend.save();
        }

        // Add to block list if not already there
        if (!user.blockedUsers.includes(req.params.friendId)) {
            user.blockedUsers.push(req.params.friendId);
        }

        await user.save();

        res.json({ msg: 'User blocked successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/auth/friends/blocked
// @desc    Get the list of users blocked by the current user
router.get('/friends/blocked', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).populate('blockedUsers', 'username email');
        if (!user) return res.status(404).json({ msg: 'User not found' });
        res.json(user.blockedUsers);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/friends/unblock/:userId
// @desc    Unblock a previously blocked user
router.post('/friends/unblock/:userId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.blockedUsers = user.blockedUsers.filter(u => u.toString() !== req.params.userId);
        await user.save();

        res.json({ msg: 'User unblocked successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/auth/friends/report/:friendId
// @desc    Report a user for abuse or spam
router.post('/friends/report/:friendId', auth, async (req, res) => {
    const { reason, details } = req.body;
    try {
        const friend = await User.findById(req.params.friendId);
        if (!friend) return res.status(404).json({ msg: 'User not found' });

        const newReport = new Report({
            reporter: req.user.id,
            reportedUser: req.params.friendId,
            reason: reason || 'Other',
            details: details || ''
        });

        await newReport.save();
        res.json({ msg: 'Report submitted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE api/auth/account
// @desc    Delete user account and clean up associations (more comprehensive)
router.delete('/account', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        // 1. Remove user from all groups (active and past)
        const Group = require('../models/Group');
        await Group.updateMany(
            { members: userId },
            { $pull: { members: userId } }
        );
        await Group.updateMany(
            { pastMembers: userId },
            { $pull: { pastMembers: userId } }
        );

        // 2. Remove user from other users' friends and blocked lists
        await User.updateMany(
            { friends: userId },
            { $pull: { friends: userId } }
        );
        await User.updateMany(
            { blockedUsers: userId },
            { $pull: { blockedUsers: userId } }
        );

        // 3. Delete reports filed by this user
        const Report = require('../models/Report');
        await Report.deleteMany({ reporter: userId });

        // Note: We intentionally DO NOT delete shared expenses.
        // This is to preserve the transaction history and balances for the friends 
        // who were part of those expenses. The 'paidBy' reference will now point to a deleted user.

        // 4. Finally, delete the user record itself
        await User.findByIdAndDelete(userId);

        res.json({ msg: 'Account and personal data deleted successfully. Shared transaction history preserved for participants.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
