const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    members: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    pastMembers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    note: {
        type: String,
        default: ''
    },
    settleUpDate: {
        type: Date,
        default: null
    },
    currency: {
        type: String,
        default: null
    },
    image: {
        type: String,
        default: null
    },
    groupType: {
        type: String,
        enum: ['default', 'community'],
        default: 'default'
    },
    paymentCycle: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        hasPaid: { type: Boolean, default: false }
    }]
}, { timestamps: true });

module.exports = mongoose.model('Group', GroupSchema);
