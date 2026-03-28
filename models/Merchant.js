const mongoose = require('mongoose');

const MerchantSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    shopName: {
        type: String,
        required: true
    },
    category: {
        type: String,
        default: 'General'
    },
    whatsappNumber: {
        type: String,
        required: true
    },
    storeAddress: {
        type: String, // Optional
    },
    upiId: {
        type: String, // For settlements
    },
    merchant_id: {
        type: String,
        unique: true
    },
    shopPhoto: {
        type: String, // URL to OCI bucket or local path
    },
    location: {
        address: String,
        coordinates: {
            lat: Number,
            lng: Number
        }
    },
    isActive: {
        type: Boolean,
        default: true
    },
    qrCode: {
        type: String // URL or base64 for UPI QR
    },
    requireCustomerApproval: {
        type: Boolean,
        default: false
    },
    lockTransactionsAfterMinutes: {
        type: Number,
        default: 5
    },
    autoLockHours: {
        type: Number,
        default: 24
    },
    isFrozen: {
        type: Boolean,
        default: false
    },
    monthlyTarget: {
        type: Number,
        default: 0
    },
    freezesOnDispute: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('Merchant', MerchantSchema);
