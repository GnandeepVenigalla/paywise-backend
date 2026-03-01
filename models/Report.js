const mongoose = require('mongoose');

const ReportSchema = new mongoose.Schema({
    reporter: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reportedUser: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reason: {
        type: String,
        required: true,
        enum: ['Spam', 'Abusive content', 'Suspicious activity', 'Impersonation', 'Other']
    },
    details: {
        type: String
    },
    status: {
        type: String,
        enum: ['Open', 'Under Review', 'Resolved', 'Dismissed'],
        default: 'Open'
    },
}, { timestamps: true });

module.exports = mongoose.model('Report', ReportSchema);
