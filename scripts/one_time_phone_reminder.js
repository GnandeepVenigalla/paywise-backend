const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const sendEmail = require('../utils/sendEmail');
const { createNotification } = require('../utils/notificationService');

async function runReminders() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/paywise');
        console.log('Connected.');

        const usersMissingPhone = await User.find({ 
            $or: [
                { phone: { $exists: false } },
                { phone: null },
                { phone: '' }
            ],
            isGhostUser: false
        });

        console.log(`Found ${usersMissingPhone.length} users with incomplete profiles.`);

        let successCount = 0;
        let failCount = 0;

        for (const user of usersMissingPhone) {
            try {
                console.log(`Processing: ${user.email}...`);
                
                // 1. In-app notification
                try {
                    await createNotification({
                        recipientId: user.id,
                        title: 'Action Required: Add Phone Number',
                        message: 'Your account is missing a phone number. Please update it in Settings to secure your account.',
                        category: 'system',
                        actionUrl: '/account'
                    });
                } catch (notiErr) {
                    console.error(`- Notification failed: ${notiErr.message}`);
                }

                // 2. Email Nudge
                await sendEmail({
                    email: user.email,
                    subject: 'Important: Complete your Paywise profile',
                    message: `Hi ${user.username},\n\nWe noticed your Paywise account is missing a phone number.\n\nAdding a phone number helps your friends find you easily and keeps your account secure.\n\nPlease update it here: ${process.env.FRONTEND_URL || 'https://www.paywiseapp.com/#/account'}\n\nHappy splitting!\nThe Paywise Team`
                });

                successCount++;
                console.log(`- Success.`);
            } catch (err) {
                console.error(`- Failed to email user ${user.email}:`, err.message);
                failCount++;
            }
        }

        console.log('------------------------------------------------');
        console.log(`Bulk processing complete.`);
        console.log(`Successfully notified: ${successCount}`);
        console.log(`Failed: ${failCount}`);
        console.log('------------------------------------------------');

        process.exit(0);
    } catch (error) {
        console.error('Fatal Error:', error.message);
        process.exit(1);
    }
}

runReminders();
