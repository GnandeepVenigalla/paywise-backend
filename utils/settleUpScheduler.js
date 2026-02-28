const cron = require('node-cron');
const Group = require('../models/Group');
const Expense = require('../models/Expense');
const sendEmail = require('./sendEmail');

/**
 * Compute net pairwise balances for a group's expenses.
 * Returns: { memberId: { otherMemberId: netAmount } }
 *   Positive = `memberId` is owed money by `otherMemberId`
 *   Negative = `memberId` owes money to `otherMemberId`
 */
function computeBalances(expenses, members) {
    // Initialize pairwise matrix
    const pairwise = {};
    members.forEach(m => {
        pairwise[m._id.toString()] = {};
        members.forEach(o => {
            if (m._id.toString() !== o._id.toString()) {
                pairwise[m._id.toString()][o._id.toString()] = 0;
            }
        });
    });

    expenses.forEach(exp => {
        const creditorId = (exp.paidBy._id || exp.paidBy).toString();
        exp.splits.forEach(split => {
            const debtorId = (split.user._id || split.user).toString();
            if (debtorId !== creditorId && pairwise[debtorId] && pairwise[debtorId][creditorId] !== undefined) {
                pairwise[debtorId][creditorId] += split.amount;
            }
        });
    });

    // Net out opposing balances
    members.forEach((a, i) => {
        members.slice(i + 1).forEach(b => {
            const aId = a._id.toString();
            const bId = b._id.toString();
            const aOwesB = pairwise[aId][bId] || 0;
            const bOwesA = pairwise[bId][aId] || 0;
            if (aOwesB > bOwesA) {
                pairwise[aId][bId] = aOwesB - bOwesA;
                pairwise[bId][aId] = 0;
            } else {
                pairwise[bId][aId] = bOwesA - aOwesB;
                pairwise[aId][bId] = 0;
            }
        });
    });

    return pairwise;
}

/**
 * Build a personal balance summary for one member.
 */
function buildMemberSummary(memberId, pairwise, allMembers) {
    const memberMap = {};
    allMembers.forEach(m => { memberMap[m._id.toString()] = m; });

    const owes = [];    // I owe these people
    const owedBy = [];  // These people owe me

    Object.entries(pairwise[memberId] || {}).forEach(([otherId, amount]) => {
        if (amount > 0.005) owes.push({ member: memberMap[otherId], amount });
    });

    allMembers.forEach(other => {
        const otherId = other._id.toString();
        if (otherId === memberId) return;
        const theyOweMe = (pairwise[otherId] || {})[memberId] || 0;
        if (theyOweMe > 0.005) owedBy.push({ member: other, amount: theyOweMe });
    });

    return { owes, owedBy };
}

/**
 * Build the HTML email body for one member.
 */
function buildEmailBody(member, group, summary) {
    const { owes, owedBy } = summary;
    const totalOwe = owes.reduce((s, r) => s + r.amount, 0);
    const totalOwed = owedBy.reduce((s, r) => s + r.amount, 0);
    const net = totalOwed - totalOwe;

    let bodyLines = [];

    if (owes.length === 0 && owedBy.length === 0) {
        bodyLines.push(`🎉 Great news — you're fully settled up in "${group.name}"! No balances outstanding.`);
    } else {
        if (owes.length > 0) {
            bodyLines.push(`💸 You owe:`);
            owes.forEach(r => {
                bodyLines.push(`   • $${r.amount.toFixed(2)} to ${r.member.username} (${r.member.email})`);
            });
            bodyLines.push('');
        }
        if (owedBy.length > 0) {
            bodyLines.push(`💰 You are owed:`);
            owedBy.forEach(r => {
                bodyLines.push(`   • $${r.amount.toFixed(2)} from ${r.member.username} (${r.member.email})`);
            });
            bodyLines.push('');
        }
        if (net > 0) {
            bodyLines.push(`📊 Net: You are owed $${net.toFixed(2)} overall.`);
        } else if (net < 0) {
            bodyLines.push(`📊 Net: You owe $${Math.abs(net).toFixed(2)} overall.`);
        }
    }

    const settleDate = new Date(group.settleUpDate).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    return [
        `Hi ${member.username},`,
        ``,
        `Today (${settleDate}) is the settle-up date for your Paywise group "${group.name}".`,
        ``,
        `Here's your balance summary:`,
        ``,
        ...bodyLines,
        ``,
        `Open the Paywise app to record payments and settle up with your group members.`,
        ``,
        `— The Paywise Team`
    ].join('\n');
}

/**
 * Main job: runs every day at 8:00 AM server time.
 * Finds all groups whose settleUpDate is today and emails every member.
 */
function startSettleUpScheduler() {
    // Run every day at 08:00
    cron.schedule('0 8 * * *', async () => {
        console.log('[SettleUp Scheduler] Running daily settle-up email check...');

        try {
            const now = new Date();
            // Build a range covering the whole of today
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

            const groups = await Group.find({
                settleUpDate: { $gte: startOfDay, $lte: endOfDay }
            }).populate('members pastMembers', 'username email');

            console.log(`[SettleUp Scheduler] Found ${groups.length} group(s) with settle-up date today.`);

            for (const group of groups) {
                const allMembers = [...(group.members || []), ...(group.pastMembers || [])];

                // Fetch all expenses for this group
                const expenses = await Expense.find({ group: group._id })
                    .populate('paidBy', 'username email')
                    .populate('splits.user', 'username email');

                const pairwise = computeBalances(expenses, allMembers);

                for (const member of group.members) {
                    const memberId = member._id.toString();
                    const summary = buildMemberSummary(memberId, pairwise, allMembers);
                    const message = buildEmailBody(member, group, summary);

                    try {
                        await sendEmail({
                            email: member.email,
                            subject: `💰 Settle-up day for "${group.name}" — Your balance summary`,
                            message
                        });
                        console.log(`[SettleUp Scheduler] Email sent to ${member.email} for group "${group.name}"`);
                    } catch (emailErr) {
                        console.error(`[SettleUp Scheduler] Failed to email ${member.email}:`, emailErr.message);
                    }
                }
            }
        } catch (err) {
            console.error('[SettleUp Scheduler] Error:', err.message);
        }
    });

    console.log('[SettleUp Scheduler] Daily settle-up email scheduler started (runs at 08:00 every day).');
}

module.exports = startSettleUpScheduler;
