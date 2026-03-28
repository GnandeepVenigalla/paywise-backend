const Expense = require('../models/Expense');
const { convertAmount } = require('./currency');

/**
 * Calculate the net balance between two users.
 * Returns positive if userId is owed by friendId.
 * Returns negative if userId owes friendId.
 */
async function calculateBalanceWithFriend(userId, friendId) {
    const expenses = await Expense.find({
        $or: [
            { paidBy: userId, 'splits.user': friendId },
            { paidBy: friendId, 'splits.user': userId }
        ]
    });

    let balance = 0; // Positive means userId is owed, Negative means userId owes

    expenses.forEach(exp => {
        const isPaidByMe = exp.paidBy.toString() === userId.toString();
        const sourceCurr = exp.currency || 'USD';
        if (isPaidByMe) {
            const friendSplit = exp.splits.find(s => s.user.toString() === friendId.toString());
            if (friendSplit) {
                balance += convertAmount(friendSplit.amount, sourceCurr, 'USD'); 
            }
        } else {
            const mySplit = exp.splits.find(s => s.user.toString() === userId.toString());
            if (mySplit) {
                balance -= convertAmount(mySplit.amount, sourceCurr, 'USD');
            }
        }
    });

    // Round to 2 decimal places to eliminate floating-point dust
    return Math.round(balance * 100) / 100;
}

module.exports = { calculateBalanceWithFriend };
