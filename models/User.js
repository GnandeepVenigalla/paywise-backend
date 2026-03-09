const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    phone: {
        type: String,
        required: false, // Enforced in registration route for new users
        unique: true,
        sparse: true, // Allows multiple null/missing values
        validate: {
            validator: function (v) {
                if (!v) return true; // Allow null/empty if not required
                return /\d{10,}/.test(v.replace(/[^\d]/g, ''));
            },
            message: props => `${props.value} is not a valid phone number!`
        }
    },
    password: {
        type: String,
        required: true
    },
    profilePic: {
        type: String,
        default: null
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    isVerified: { type: Boolean, default: false },
    emailVerificationOtp: String,
    emailVerificationExpire: Date,
    friends: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    blockedUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    friendNotes: [{
        friend: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: { type: String, default: '' }
    }],
    friendSettings: [{
        friend: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        interestRate: { type: Number, default: 0 },
        interestEnabled: { type: Boolean, default: false },
        lastInterestApplied: { type: Date, default: Date.now }
    }],
    notificationSettings: {
        addedToGroup: { type: Boolean, default: true },
        addedAsFriend: { type: Boolean, default: true },
        expenseAdded: { type: Boolean, default: false },
        expenseEdited: { type: Boolean, default: false },
        expenseCommented: { type: Boolean, default: false },
        expenseDue: { type: Boolean, default: true },
        expensePaid: { type: Boolean, default: true },
        monthlySummary: { type: Boolean, default: true },
        majorUpdates: { type: Boolean, default: true },
    },
    defaultCurrency: { type: String, default: 'USD' },
    timezone: { type: String, default: 'America/New_York' },
    appSettings: {
        // Financial Customization
        defaultSplitMethod: { type: String, default: 'equally' }, // 'equally' | 'percentage' | 'full'
        monthlyBudget: { type: Number, default: 0 },
        // Display & Accessibility
        theme: { type: String, default: 'system' }, // 'light' | 'dark' | 'system'
        highContrastMode: { type: Boolean, default: false },
        dateFormat: { type: String, default: 'MM/DD/YYYY' }, // 'DD/MM/YYYY' | 'MM/DD/YYYY'
        timeFormat: { type: String, default: '12h' }, // '12h' | '24h'
        language: { type: String, default: 'English' },
        // Privacy & Social
        profileVisibility: { type: Boolean, default: true },
        autoAcceptFriends: { type: Boolean, default: false },
        hideBalance: { type: Boolean, default: false },
        // Security
        biometricLock: { type: Boolean, default: false },
        biometricCredentialId: { type: String },
    },
    splitwiseToken: { type: String },
    splitwiseMigrationStatus: {
        type: String,
        enum: ['none', 'pending', 'completed'],
        default: 'none'
    },
    // Ghost users are created during Splitwise migration for people not yet on Paywise.
    // They hold real expense/group data. When the person registers with the same email,
    // their account is promoted to a full account automatically.
    isGhostUser: { type: Boolean, default: false },
    avatarInitials: { type: String }, // stored so ghost user displays correctly
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);
