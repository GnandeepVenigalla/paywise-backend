const cron = require('node-cron');
const { v4: uuidv4 } = require('crypto');
const Expense = require('../models/Expense');
const { notifyMany } = require('./notificationService');

/** Advance a date by the given recurrence frequency (month-end safe). */
function nextDate(date, frequency) {
    const d = new Date(date);
    switch (frequency) {
        case 'weekly':   d.setDate(d.getDate() + 7); break;
        case 'biweekly': d.setDate(d.getDate() + 14); break;
        case 'monthly': {
            const origDay = d.getDate();
            d.setMonth(d.getMonth() + 1);
            const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
            if (origDay > daysInMonth) d.setDate(daysInMonth);
            break;
        }
        case 'yearly':  d.setFullYear(d.getFullYear() + 1); break;
        default: break;
    }
    return d;
}

function startRecurringScheduler() {
    // Runs at 00:01 AM every day
    cron.schedule('1 0 * * *', async () => {
        console.log('[RecurringScheduler] Running...');
        try {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

            // Find all template (parent) recurring expenses due today
            const due = await Expense.find({
                isRecurring: true,
                nextRecurrenceDate: { $gte: todayStart, $lt: todayEnd }
            }).populate('paidBy splits.user addedBy');

            console.log(`[RecurringScheduler] ${due.length} due today.`);

            for (const template of due) {
                try {
                    // Stop if end date has passed
                    if (template.recurrenceEndDate && new Date(template.recurrenceEndDate) < todayStart) {
                        template.nextRecurrenceDate = null;
                        template.isRecurring = false;
                        await template.save();
                        console.log(`[RecurringScheduler] "${template.description}" end date passed. Stopped.`);
                        continue;
                    }

                    // Clone as a new non-template expense instance
                    const instance = new Expense({
                        description: template.description,
                        amount: template.amount,
                        currency: template.currency,
                        group: template.group,
                        paidBy: template.paidBy._id || template.paidBy,
                        splits: template.splits.map(s => ({
                            user: s.user._id || s.user,
                            amount: s.amount
                        })),
                        addedBy: template.addedBy?._id || template.addedBy || template.paidBy._id || template.paidBy,
                        isLoan: false,
                        billImage: null,
                        isRecurring: false,             // Instance is NOT a template
                        recurrenceId: template.recurrenceId, // linked to parent series
                        date: new Date()
                    });
                    await instance.save();

                    // Advance template to next date
                    template.nextRecurrenceDate = nextDate(template.nextRecurrenceDate, template.recurrenceFrequency);

                    // Auto-stop if next occurrence is past end date
                    if (template.recurrenceEndDate && template.nextRecurrenceDate > new Date(template.recurrenceEndDate)) {
                        template.isRecurring = false;
                        template.nextRecurrenceDate = null;
                    }
                    await template.save();

                    // Notify all split participants
                    const allIds = [...new Set(
                        template.splits.map(s => (s.user._id || s.user).toString())
                    )];
                    const payerId = (template.paidBy._id || template.paidBy).toString();
                    const recipientIds = allIds.filter(id => id !== payerId);
                    if (recipientIds.length > 0) {
                        notifyMany({
                            recipientIds,
                            title: `🔁 Recurring bill: "${template.description}"`,
                            message: `A new entry for "${template.description}" has been posted automatically.`,
                            category: 'expense',
                            type: 'info',
                            actionUrl: template.group ? `/group/${template.group}` : `/friend/${payerId}`,
                            metadata: { actionType: 'recurring_posted', expenseId: instance._id }
                        }).catch(e => console.error('[RecurringScheduler] Notify error:', e.message));
                    }

                    console.log(`[RecurringScheduler] Posted instance for "${template.description}" (series ${template.recurrenceId})`);
                } catch (innerErr) {
                    console.error(`[RecurringScheduler] Error on "${template.description}":`, innerErr.message);
                }
            }

            console.log('[RecurringScheduler] Done.');
        } catch (err) {
            console.error('[RecurringScheduler] Fatal error:', err.message);
        }
    });

    console.log('[RecurringScheduler] Started — runs daily at 00:01 AM.');
}

module.exports = { startRecurringScheduler, nextDate };
