const cron = require('node-cron');
const Expense = require('../models/Expense');
const LoanRequest = require('../models/LoanRequest');
const { calculateBalanceWithFriend } = require('./balanceHelper');
const { convertAmount } = require('./currency');

/**
 * Daily interest scheduler — runs at 00:05 AM every day.
 *
 * Rules:
 *  1. Only processes loans where a LoanRequest exists with status = 'accepted'
 *  2. Interest accrues from the acceptedAt date, NOT the expense creation date
 *  3. Interest is calculated in the loan's NATIVE currency (preserves multi-currency accuracy)
 *  4. If the net balance (in USD) is fully settled, the loan is auto-closed
 *  5. Skips loans where interest was already applied today
 */
function startInterestScheduler() {
    cron.schedule('5 0 * * *', async () => {
        console.log('[Interest Scheduler] Running daily interest calculation...');

        try {
            // Only process accepted loans — pending loans do NOT accrue interest
            const acceptedLoanRequests = await LoanRequest.find({ status: 'accepted' });

            if (acceptedLoanRequests.length === 0) {
                console.log('[Interest Scheduler] No accepted loans found. Skipping.');
                return;
            }

            const expenseIds = acceptedLoanRequests.map(lr => lr.expense);

            // Load only expenses that:
            //  a) are marked as loans with a positive rate
            //  b) have an accepted LoanRequest
            const activeLoans = await Expense.find({
                _id: { $in: expenseIds },
                isLoan: true,
                loanInterestRate: { $gt: 0 }
            }).populate('paidBy splits.user');

            console.log(`[Interest Scheduler] Found ${activeLoans.length} accepted loan expense(s).`);

            const today = new Date().setHours(0, 0, 0, 0);

            for (const loan of activeLoans) {
                // Find the linked LoanRequest to get the exact acceptedAt date
                const loanReq = acceptedLoanRequests.find(
                    lr => lr.expense.toString() === loan._id.toString()
                );
                if (!loanReq) continue;

                const creditorId = loan.paidBy._id || loan.paidBy;
                let interestAppliedThisRun = false;

                for (const split of loan.splits) {
                    const debtorId = split.user._id || split.user;
                    if (creditorId.toString() === debtorId.toString()) continue;

                    // Guard: don't apply interest before acceptance date
                    const acceptedAt = loanReq.acceptedAt
                        ? new Date(loanReq.acceptedAt).setHours(0, 0, 0, 0)
                        : null;
                    if (!acceptedAt) continue;
                    if (today < acceptedAt) {
                        console.log(`[Interest Scheduler] Loan "${loan.description}" not yet due — acceptedAt is in the future.`);
                        continue;
                    }

                    // Idempotency: skip if already applied today
                    const lastApplied = loan.lastInterestApplied
                        ? new Date(loan.lastInterestApplied).setHours(0, 0, 0, 0)
                        : null;
                    if (lastApplied === today) continue;

                    // Check net balance (in USD) to auto-close settled loans
                    const netBalanceUSD = await calculateBalanceWithFriend(creditorId, debtorId);
                    if (netBalanceUSD <= 0.01) {
                        console.log(`[Interest Scheduler] Loan "${loan.description}" fully settled. Auto-closing.`);
                        loan.loanInterestRate = 0;
                        await loan.save();
                        loanReq.status = 'accepted'; // keep accepted but rate is 0
                        continue;
                    }

                    // ── Calculate interest in the loan's NATIVE currency ──────────
                    // This preserves precision and avoids double-conversion rounding
                    const loanPortion = split.amount; // native currency amount
                    
                    // Cap at net balance converted to native currency
                    const netBalanceNative = convertAmount(netBalanceUSD, 'USD', loan.currency || 'USD');
                    const interestBearingAmount = Math.min(loanPortion, netBalanceNative);

                    const dailyRate = (loan.loanInterestRate / 100) / 365;
                    const interestAmount = Math.round(interestBearingAmount * dailyRate * 10000) / 10000; // 4dp precision

                    if (interestAmount >= 0.0001) {
                        const interestExpense = new Expense({
                            description: `Interest accrual on "${loan.description}" (${loan.loanInterestRate}% APR)`,
                            amount: Math.round(interestAmount * 100) / 100, // round to 2dp for display
                            currency: loan.currency || 'USD', // ← same currency as the loan
                            paidBy: creditorId,
                            splits: [{
                                user: debtorId,
                                amount: Math.round(interestAmount * 100) / 100
                            }],
                            parentLoan: loan._id,
                            addedBy: creditorId,
                            date: new Date()
                        });

                        await interestExpense.save();
                        interestAppliedThisRun = true;
                        console.log(`[Interest Scheduler] Applied ${loan.currency || 'USD'} ${interestAmount.toFixed(4)} interest on "${loan.description}" for debtor ${debtorId}`);
                    } else {
                        // Interest too tiny to record — still mark as processed today
                        interestAppliedThisRun = true;
                        console.log(`[Interest Scheduler] Interest for "${loan.description}" is below minimum (${interestAmount.toFixed(6)}). Skipping entry.`);
                    }
                }

                if (interestAppliedThisRun) {
                    loan.lastInterestApplied = new Date();
                    await loan.save();
                }
            }

            console.log('[Interest Scheduler] Done.');
        } catch (err) {
            console.error('[Interest Scheduler] Error:', err.message);
        }
    });

    console.log('[Interest Scheduler] Daily loan interest scheduler started (runs at 00:05 every day).');
}

module.exports = startInterestScheduler;
