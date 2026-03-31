const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null // null means system-wide or role-based
  },
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
    type: String, // e.g., 'expense', 'loan', 'friend', 'system'
    default: 'system'
  },
  isRead: {
    type: Boolean,
    default: false
  },
  targetRole: {
    type: String,
    default: null
  },
  actionUrl: {
    type: String,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

// Basic TTL index so notifications auto-delete after 30 days to prevent bloat
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);
