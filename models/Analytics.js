const mongoose = require('mongoose');

const AnalyticsSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true,
        unique: true,
        index: true
    },
    visits: {
        type: Number,
        default: 0
    },
    adRequests: {
        type: Number,
        default: 0
    },
    adImpressions: {
        type: Number,
        default: 0
    },
    adClicks: {
        type: Number,
        default: 0
    },
    adRevenue: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

module.exports = mongoose.model('Analytics', AnalyticsSchema);
