const mongoose = require('mongoose');

const ActivitySchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    action: {
        type: String,
        required: true
    },
    category: {
        type: String, // 'user', 'group', 'expense', 'security', 'system'
        required: true
    },
    details: {
        type: String
    },
    status: {
        type: String,
        default: 'info' // 'success', 'warning', 'info', 'error'
    }
}, { timestamps: true });

module.exports = mongoose.model('Activity', ActivitySchema);
