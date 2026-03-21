const cron = require('node-cron');
const Expense = require('../models/Expense');
const { calculateBalanceWithFriend } = require('./balanceHelper');

/**
 * Periodically calculate and apply interest to specific expenses marked as loans.
 * The scheduler runs every day shortly after midnight.
 */
function startInterestScheduler() {
    // Run every day at 00:05 AM
    cron.schedule('5 0 * * *', async () => {
        console.log('[Interest Scheduler] Running daily interest calculation for specific loans...');

        try {
            // Find all active loan expenses with a positive interest rate
            const activeLoans = await Expense.find({ 
                isLoan: true, 
                loanInterestRate: { $gt: 0 } 
            }).populate('paidBy splits.user');

            console.log(`[Interest Scheduler] Found ${activeLoans.length} active loan expense(s).`);

            const today = new Date().setHours(0, 0, 0, 0);

            for (const loan of activeLoans) {
                const creditorId = loan.paidBy._id || loan.paidBy;
                let interestAppliedThisRun = false;

                // Track interest per debtor in the loan
                for (const split of loan.splits) {
                    const debtorId = split.user._id || split.user;
                    if (creditorId.toString() === debtorId.toString()) continue;

                    // Check if interest was already applied to this loan today
                    const lastApplied = loan.lastInterestApplied ? new Date(loan.lastInterestApplied).setHours(0, 0, 0, 0) : null;
                    if (lastApplied === today) continue;

                    // Check overall net balance with this specific friend to ensure they still owe money
                    const netBalance = await calculateBalanceWithFriend(creditorId, debtorId);

                    // If net balance is fully settled, auto-close this loan so scheduler skips it in future
                    if (netBalance <= 0.01) {
                        console.log(`[Interest Scheduler] Loan "${loan.description}" fully settled. Auto-closing (setting rate to 0).`);
                        loan.loanInterestRate = 0;
                        await loan.save();
                        continue; // no interest this run
                    }

                    // Interest applies to the debtor's portion of THIS specific loan
                    const loanPortion = split.amount;

                    // We cap the interest-bearing amount by the actual net balance
                    // (prevents charging interest if they've paid back enough to cover the loan but other small expenses remain)
                    const interestBearingAmount = Math.min(loanPortion, netBalance);

                    const dailyRate = (loan.loanInterestRate / 100) / 365;
                    const interestAmount = interestBearingAmount * dailyRate;

                    if (interestAmount >= 0.01) {
                        const interestExpense = new Expense({
                            description: `Interest on loan: "${loan.description}" (${loan.loanInterestRate}% APR)`,
                            amount: interestAmount,
                            currency: loan.currency || 'USD',
                            paidBy: creditorId,
                            splits: [{
                                user: debtorId,
                                amount: interestAmount
                            }],
                            parentLoan: loan._id,
                            addedBy: creditorId,
                            date: new Date()
                        });

                        await interestExpense.save();
                        interestAppliedThisRun = true;
                        console.log(`[Interest Scheduler] Applied $${interestAmount.toFixed(4)} interest on loan "${loan.description}" for debtor ${debtorId}`);
                    }
                }

                // Update the loan's last interest applied date only if we actually ran today
                if (interestAppliedThisRun) {
                    loan.lastInterestApplied = new Date();
                    await loan.save();
                }
            }
        } catch (err) {
            console.error('[Interest Scheduler] Error during execution:', err.message);
        }
    });

    console.log('[Interest Scheduler] Daily specific loan interest scheduler started (runs at 00:05 every day).');
}

module.exports = startInterestScheduler;
