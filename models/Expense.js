const mongoose = require('mongoose');

const ExpenseSchema = new mongoose.Schema({
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' }, // Can be null for individual expenses
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, default: Date.now },
    splits: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        amount: { type: Number, required: true } // Expected amount to pay back 
    }]
}, { timestamps: true });

module.exports = mongoose.model('Expense', ExpenseSchema);
