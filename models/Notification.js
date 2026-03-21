const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['info', 'warning', 'error', 'success'],
    default: 'info'
  },
  category: {
    type: String, // e.g., 'system_health', 'user_report', 'kyc', 'billing', 'security'
    default: 'system'
  },
  isRead: {
    type: Boolean,
    default: false
  },
  targetRole: {
    type: String, // e.g., 'root', 'admin', 'all'
    default: 'all'
  },
  actionUrl: {
    type: String, // optional deep link when admin clicks the notification
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed, // flexible data
    default: {}
  }
}, { timestamps: true });

// Basic TTL index so notifications auto-delete after 30 days to prevent bloat
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);
