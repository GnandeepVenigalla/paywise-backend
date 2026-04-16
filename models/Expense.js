const mongoose = require('mongoose');

const ExpenseSchema = new mongoose.Schema({
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' }, // Can be null for individual expenses
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, default: Date.now },
    splits: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        amount: { type: Number, required: true } // Expected amount to pay back 
    }],
    items: [{
        name: { type: String, required: true },
        price: { type: Number, required: true },
        assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
    }],
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isLoan: { type: Boolean, default: false },
    loanInterestRate: { type: Number, default: 0 },
    lastInterestApplied: { type: Date },
    parentLoan: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
    billImage: { type: String, default: null },
    // ── Recurring bill fields ──────────────────────────────
    isRecurring: { type: Boolean, default: false },
    recurrenceId: { type: String, default: null },          // shared UUID linking all instances
    recurrenceFrequency: { type: String, enum: ['weekly', 'biweekly', 'monthly', 'yearly', null], default: null },
    recurrenceEndDate: { type: Date, default: null },       // null = until cancelled
    nextRecurrenceDate: { type: Date, default: null },      // null on non-template instances
}, { timestamps: true });

module.exports = mongoose.model('Expense', ExpenseSchema);
