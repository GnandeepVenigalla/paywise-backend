const mongoose = require('mongoose');

const SupportTicketSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    subject: {
        type: String,
        required: true,
        trim: true
    },
    message: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['open', 'in-progress', 'closed'],
        default: 'open'
    },
    adminResponse: {
        type: String,
        default: ''
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'critical'],
        default: 'medium'
    },
    replies: [
        {
            sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            message: String,
            isAdmin: { type: Boolean, default: false },
            createdAt: { type: Date, default: Date.now }
        }
    ],
    closedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

module.exports = mongoose.model('Support', SupportTicketSchema);
