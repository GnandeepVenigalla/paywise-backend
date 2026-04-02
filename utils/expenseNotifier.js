const sendEmail = require('./sendEmail');
const User = require('../models/User');
const Group = require('../models/Group');

// ─── Currency symbol helper ─────────────────────────────────────────────────
const CURRENCY_SYMBOLS = {
    USD: '$', EUR: '€', GBP: '£', INR: '₹', CAD: 'CA$', AUD: 'A$',
    JPY: '¥', CNY: '¥', CHF: 'CHF', MXN: 'MX$', BRL: 'R$', SGD: 'S$', AED: 'AED'
};
const sym = (code) => CURRENCY_SYMBOLS[code] || code || '$';
const fmt = (amount, currency = 'USD') =>
    `${sym(currency)}${Math.abs(Number(amount)).toFixed(2)}`;

// ─── HTML Email Template ────────────────────────────────────────────────────
function buildEmailHtml({ actionType, actorName, recipientName, description, amount, currency, groupName, appUrl = 'https://paywiseapp.com' }) {
    const colorMap = {
        added:   { bg: '#f0fdf4', accent: '#16a34a', icon: '➕', label: 'New Expense Added' },
        edited:  { bg: '#fffbeb', accent: '#d97706', icon: '✏️',  label: 'Expense Updated' },
        deleted: { bg: '#fff1f2', accent: '#e11d48', icon: '🗑️', label: 'Expense Deleted' },
        settled: { bg: '#eff6ff', accent: '#2563eb', icon: '✅', label: 'Settled Up' },
        community_turn: { bg: '#fff7ed', accent: '#ea580c', icon: '🔄', label: 'Turn Recorded' },
    };
    const { bg, accent, icon, label } = colorMap[actionType] || colorMap.added;
    const context = groupName ? `in group <strong>${groupName}</strong>` : 'between you two';

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${label} — Paywise</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#064e3b 0%,#065f46 100%);padding:28px 32px;text-align:center;">
          <img src="https://paywiseapp.com/logo.png" alt="Paywise" width="40" height="40" style="border-radius:10px;margin-bottom:10px;" onerror="this.style.display='none'">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Paywise</h1>
          <p style="margin:4px 0 0;color:#a7f3d0;font-size:13px;">Smart Bill Splitting</p>
        </td></tr>

        <!-- Action Banner -->
        <tr><td style="background:${bg};border-bottom:2px solid ${accent}20;padding:20px 32px;text-align:center;">
          <span style="font-size:28px;">${icon}</span>
          <p style="margin:6px 0 0;font-size:16px;font-weight:800;color:${accent};text-transform:uppercase;letter-spacing:0.05em;">${label}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 20px;font-size:16px;color:#374151;line-height:1.6;">
            Hi <strong>${recipientName}</strong>,<br>
            <strong>${actorName}</strong> ${actionType === 'community_turn' ? 'just recorded a turn' : getActionVerb(actionType)} an expense ${context}.
          </p>

          <!-- Expense Card -->
          <table width="100%" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin-bottom:24px;">
            <tr><td style="padding:20px 24px;">
              <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em;">
                ${actionType === 'settled' ? 'Settlement' : 'Expense'}
              </p>
              <p style="margin:0 0 12px;font-size:20px;font-weight:800;color:#111827;">${description}</p>
              ${amount > 0 ? `
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="background:${accent};color:#fff;font-size:22px;font-weight:900;padding:6px 14px;border-radius:8px;">${fmt(amount, currency)}</span>
                ${groupName ? `<span style="font-size:13px;color:#6b7280;">· ${groupName}</span>` : ''}
              </div>` : ''}
            </td></tr>
          </table>

          ${actionType === 'deleted' ? `
          <p style="margin:0 0 24px;font-size:14px;color:#6b7280;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;">
            ⚠️ This expense has been <strong>permanently deleted</strong> and your balance has been recalculated automatically.
          </p>` : ''}

          ${actionType === 'settled' ? `
          <p style="margin:0 0 24px;font-size:14px;color:#374151;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 16px;">
            🎉 Your balance ${context} has been updated. Open the app to see your new standing.
          </p>` : ''}

          ${actionType === 'community_turn' ? `
          <div style="margin:0 0 24px;font-size:14px;color:#374151;background:#fff7ed;border:1px solid #ffedd5;border-radius:12px;padding:16px;">
            ${recipientName.includes('(Next)') ? `
                <div style="display:flex;align-items:start;gap:12px;">
                    <span style="font-size:24px;">🎯</span>
                    <div>
                        <strong style="color:#ea580c;font-size:16px;">You are next in line!</strong>
                        <p style="margin:4px 0 0;color:#9a3412;">It's your turn to pick up the next bill. The group is counting on you! 🚀</p>
                    </div>
                </div>
            ` : `
                <p style="margin:0;color:#9a3412;">The rotation is moving! Check out who's next in the app to keep things fair.</p>
            `}
          </div>` : ''}

          <!-- CTA -->
          <div style="text-align:center;margin-bottom:8px;">
            <a href="${appUrl}" style="display:inline-block;background:#059669;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;letter-spacing:0.02em;">Open Paywise →</a>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:16px 32px 28px;text-align:center;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.7;">
            You received this because you have expense notifications enabled.<br>
            <a href="${appUrl}/account/notifications" style="color:#059669;text-decoration:none;">Manage notification settings</a> · 
            <a href="${appUrl}" style="color:#9ca3af;text-decoration:none;">paywiseapp.com</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function getActionVerb(actionType) {
    return { added: 'added', edited: 'updated', deleted: 'deleted', settled: 'recorded a settlement for' }[actionType] || 'updated';
}

// ─── Plain text fallback ────────────────────────────────────────────────────
function buildEmailText({ actionType, actorName, recipientName, description, amount, currency, groupName }) {
    const verb = getActionVerb(actionType);
    const context = groupName ? `in group "${groupName}"` : '';
    const amtStr = amount > 0 ? ` (${fmt(amount, currency)})` : '';
    return [
        `Hi ${recipientName},`,
        '',
        `${actorName} ${verb} an expense ${context}: "${description}"${amtStr}.`,
        '',
        actionType === 'deleted'
            ? 'This expense has been permanently deleted and your balance has been updated.'
            : actionType === 'settled'
            ? 'Your balance has been updated. Open Paywise to see your new standing.'
            : 'Open Paywise to see the details and your updated balance.',
        '',
        'https://paywiseapp.com',
        '',
        '— The Paywise Team',
        '',
        'To change your notification preferences, visit: https://paywiseapp.com/account/notifications',
    ].join('\n');
}

// ─── Core notification dispatcher ──────────────────────────────────────────
/**
 * Send expense email notifications to all relevant participants.
 *
 * @param {Object} opts
 * @param {string}   opts.actionType  - 'added' | 'edited' | 'deleted' | 'settled'
 * @param {Object}   opts.expense     - The expense document (populated or raw)
 * @param {string}   opts.actorId     - The user who performed the action (req.user.id)
 * @param {string}   [opts.groupId]   - Group ID if it's a group expense
 */
async function notifyExpenseAction({ actionType, expense, actorId, groupId }) {
    try {
        // 1. Load the actor
        const actor = await User.findById(actorId).select('username email');
        if (!actor) return;

        // 2. Collect all recipient IDs (everyone in splits + paidBy), excluding the actor
        const participantIds = new Set();

        const paidById = expense.paidBy?._id?.toString() || expense.paidBy?.toString();
        if (paidById && paidById !== actorId.toString()) participantIds.add(paidById);

        (expense.splits || []).forEach(s => {
            const uid = s.user?._id?.toString() || s.user?.toString();
            if (uid && uid !== actorId.toString()) participantIds.add(uid);
        });

        // For group expenses, also notify group members not in splits
        if (groupId) {
            const group = await Group.findById(groupId).select('members');
            if (group) {
                group.members.forEach(m => {
                    const uid = m.toString();
                    if (uid !== actorId.toString()) participantIds.add(uid);
                });
            }
        }

        if (participantIds.size === 0) return;

        // 3. Load all recipients with their notification settings
        const recipients = await User.find({
            _id: { $in: [...participantIds] }
        }).select('username email notificationSettings');

        // 4. Determine which notification flag to check
        const flagMap = {
            added:   'expenseAdded',
            edited:  'expenseEdited',
            deleted: 'expenseEdited',   // shares the "edited/deleted" toggle
            settled: 'expensePaid',
        };
        const requiredFlag = flagMap[actionType] || 'expenseAdded';

        // 5. Resolve group name if needed
        let groupName = null;
        if (groupId) {
            const g = await Group.findById(groupId).select('name');
            groupName = g?.name || null;
        }

        // 6. Send to each recipient who has the flag enabled
        const emailPromises = recipients
            .filter(r => r.notificationSettings?.[requiredFlag] === true)
            .map(recipient => {
                const subject = buildSubject(actionType, actor.username, expense.description);
                const html = buildEmailHtml({
                    actionType,
                    actorName: actor.username,
                    recipientName: recipient.username,
                    description: expense.description,
                    amount: expense.amount,
                    currency: expense.currency || 'USD',
                    groupName,
                });
                const text = buildEmailText({
                    actionType,
                    actorName: actor.username,
                    recipientName: recipient.username,
                    description: expense.description,
                    amount: expense.amount,
                    currency: expense.currency || 'USD',
                    groupName,
                });

                return sendEmail({
                    email: recipient.email,
                    subject,
                    message: text,
                    html,  // Pass html for rich email (sendEmail will need to support it)
                }).catch(err => {
                    // Never let an email error crash the main request
                    console.error(`[Notifier] Failed to email ${recipient.email}:`, err.message);
                });
            });

        await Promise.allSettled(emailPromises);
        
        // 7. Create in-app notifications (newly added)
        const { notifyMany } = require('./notificationService');
        const labels = {
            added:   'added an expense',
            edited:  'updated an expense',
            deleted: 'permanently deleted an expense',
            settled: 'recorded a settlement for'
        };
        const verb = labels[actionType] || 'updated';
        const context = groupName ? `in group "${groupName}"` : 'between you two';
        const msg = `${actor.username} ${verb} "${expense.description}" ${context}.`;
        
        await notifyMany({
            recipientIds: [...participantIds],
            title: buildSubject(actionType, actor.username, expense.description),
            message: msg,
            category: 'expense',
            type: actionType === 'deleted' ? 'warning' : actionType === 'settled' ? 'success' : 'info',
            actionUrl: groupId ? `/group/${groupId}?expenseId=${expense._id?.toString()}` : `/friend/${actorId}?expenseId=${expense._id?.toString()}`, 
            metadata: { 
                actionType, 
                actorId, 
                expenseId: expense._id?.toString(), 
                groupId: groupId?.toString() 
            }
        });

    } catch (err) {
        // Silent fail — never disrupt the API response
        console.error('[Notifier] Error in notifyExpenseAction:', err.message);
    }
}

function buildSubject(actionType, actorName, description) {
    const truncated = description?.length > 40 ? description.slice(0, 40) + '…' : description;
    const labels = {
        added:   `💰 ${actorName} added "${truncated}"`,
        edited:  `✏️ ${actorName} updated "${truncated}"`,
        deleted: `🗑️ ${actorName} deleted "${truncated}"`,
        settled: `✅ ${actorName} settled up — "${truncated}"`,
    };
    return labels[actionType] || `Paywise: expense update — "${truncated}"`;
}

/**
 * Specialized notifier for community groups to announce turns and identify the "next" person.
 */
async function notifyCommunityUpdate({ group, actorId, expenseDescription }) {
    try {
        const Group = require('../models/Group');
        const targetGroup = await Group.findById(group).populate('members', 'username email notificationSettings');
        if (!targetGroup) return;

        const actor = await User.findById(actorId).select('username');
        const actorName = actor?.username || 'Someone';

        // Find the "Next" person in the rotation (first hasPaid: false)
        const nextInLineMemberId = targetGroup.paymentCycle?.find(c => !c.hasPaid)?.user?.toString();

        const emailPromises = targetGroup.members.map(member => {
            if (member._id.toString() === actorId.toString()) return null;
            if (member.notificationSettings?.expenseAdded === false) return null;

            const isNextInLine = member._id.toString() === nextInLineMemberId;
            const recipientName = isNextInLine ? `${member.username} (Next)` : member.username;

            const subject = isNextInLine 
                ? `🎯 It's your turn in ${targetGroup.name}!` 
                : `🔄 ${actorName} recorded a turn in ${targetGroup.name}`;

            const html = buildEmailHtml({
                actionType: 'community_turn',
                actorName,
                recipientName,
                description: expenseDescription,
                amount: 0,
                currency: targetGroup.currency || 'USD',
                groupName: targetGroup.name,
            });

            const text = `${member.username},\n\n${actorName} just recorded a turn in ${targetGroup.name}: "${expenseDescription}".\n\n${isNextInLine ? "🎯 YOU ARE NEXT! It is your turn to pay the next bill." : "The rotation has moved. Open the app to see who is next!"}\n\nhttps://paywiseapp.com`;

            return sendEmail({
                email: member.email,
                subject,
                message: text,
                html
            }).catch(e => console.error(`[CommunityNotifier] Error sending to ${member.email}:`, e.message));
        });

        await Promise.allSettled(emailPromises);
        
        // ── Create In-App Notifications for Community Group ────────────────
        const { createNotification } = require('./notificationService');
        for (const member of targetGroup.members) {
            if (member._id.toString() === actorId.toString()) continue;
            
            const isNextInLine = member._id.toString() === nextInLineMemberId;
            const title = isNextInLine 
                ? `🎯 It's your turn in ${targetGroup.name}!` 
                : `🔄 Rotations move in ${targetGroup.name}`;
            
            const msg = isNextInLine 
                ? `It's your turn to pay the next bill for "${expenseDescription}". Stay sharp!` 
                : `${actorName} recorded a turn. Check who's next in line!`;

            await createNotification({
                recipientId: member._id,
                title,
                message: msg,
                type: isNextInLine ? 'success' : 'info',
                category: 'expense',
                actionUrl: `/group/${group.toString()}`,
                metadata: { groupId: group.toString(), isNextInLine }
            });
        }

    } catch (err) {
        console.error('[CommunityNotifier] Error:', err.message);
    }
}

module.exports = { notifyExpenseAction, notifyCommunityUpdate };
