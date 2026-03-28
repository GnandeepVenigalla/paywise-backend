const mongoose = require('mongoose');

const KathaSchema = new mongoose.Schema({
    merchant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Merchant',
        required: true
    },
    // The customer can be an existing User or a custom record (e.g., if the user doesn't have the app)
    customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false // Optional if they aren't on Paywise yet
    },
    customerName: {
        type: String,
        required: true // Required even if not a registered User
    },
    customerPhone: {
        type: String,
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    entryType: {
        type: String,
        enum: ['UDHAR', 'JAMA'], // UDHAR = Udhaar/Debt (Bag), JAMA = Payment (Hand)
        required: true
    },
    description: {
        type: String, // e.g., "Milk - ₹30"
        default: ''
    },
    itemList: [{
        name: String,
        price: Number
    }],
    date: {
        type: Date,
        default: Date.now
    },
    voiceUrl: {
        type: String // URL to voice note if needed
    },
    isSettled: {
        type: Boolean,
        default: false
    },
    isCorrection: {
        type: Boolean,
        default: false
    },
    originalEntry: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Katha'
    },
    approvalStatus: {
        type: String,
        enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'CORRECTION_REQUESTED'],
        default: 'ACCEPTED' 
    },
    status: {
        type: String,
        enum: ['LOCKED', 'DISPUTED', 'PENDING_APPROVAL', 'CONFLICT_DETECTED'],
        default: 'LOCKED'
    },
    disputeReason: {
        type: String
    },
    merchantReply: {
        type: String,
        default: ''
    },
    isFrozen: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = mongoose.model('Katha', KathaSchema);
