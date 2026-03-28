const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const cyberDefense = require('./middleware/cyberDefense');
app.use(cyberDefense);

// Routes
const authRoutes = require('./routes/auth');
const groupRoutes = require('./routes/groups');
const expenseRoutes = require('./routes/expenses');
const splitwiseRoutes = require('./routes/splitwise');
const uploadRoutes = require('./routes/upload');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const analyticsRoutes = require('./routes/analytics');
const supportRoutes = require('./routes/support');
const merchantRoutes = require('./routes/merchant');
const loanRoutes = require('./routes/loans');

app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/splitwise', splitwiseRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/merchant', merchantRoutes);
app.use('/api/loans', loanRoutes);

// Schedulers
const startSettleUpScheduler = require('./utils/settleUpScheduler');
const { updateRates } = require('./utils/currency');

const PORT = process.env.PORT || 5001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/paywise';

mongoose.connect(MONGO_URI).then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        // Start the daily settle-up email scheduler
        startSettleUpScheduler();
        // Start the daily friend loan interest scheduler
        const startInterestScheduler = require('./utils/interestScheduler');
        startInterestScheduler();
        // Start the support ticket 7-day cleanup protocol
        const startSupportCleanup = require('./utils/supportCleanup');
        startSupportCleanup();
        // Fetch live exchange rates and schedule 12-hour refresh cycle
        updateRates();
        setInterval(updateRates, 1000 * 60 * 60 * 12);
    });
}).catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
});

