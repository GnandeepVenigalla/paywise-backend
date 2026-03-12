const mongoose = require('mongoose');

const BugSchema = new mongoose.Schema({
    description: {
        type: String,
        required: true
    },
    version: {
        type: String,
        default: 'v2.4.0-beta.1'
    },
    reporter: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    status: {
        type: String,
        enum: ['open', 'resolved'],
        default: 'open'
    },
    severity: {
        type: String,
        enum: ['low', 'medium', 'high', 'critical'],
        default: 'medium'
    }
}, { timestamps: true });

module.exports = mongoose.model('Bug', BugSchema);
