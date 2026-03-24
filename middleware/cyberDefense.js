const logActivity = require('../utils/activityLogger');

const cyberDefense = async (req, res, next) => {
    // 1. Enforce strict HTTP Security Headers to prevent malware injection and sniffing
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' https: data:;");

    try {
        if (req.method === 'POST' || req.method === 'PUT') {
            const payloadString = JSON.stringify({ ...req.body, ...req.query });
            
            // 2. Scan for Malware, Cross-site Scripting, and NoSQL injection
            const attackVectors = ['<script>', 'javascript:', 'document.cookie', '$where'];
            
            for (let vector of attackVectors) {
                if (payloadString.toLowerCase().includes(vector.toLowerCase())) {
                    
                    // 3. Report the hacker to the Admin Dashboard (activity logs)
                    const userId = req.user ? req.user.id : null;
                    await logActivity({
                        user: userId, // May be null if unauthorized attack
                        action: 'System Defense: Blocked Malware/Injection Attack',
                        category: 'security',
                        details: `Blocked attack vector: [${vector}]. IP: ${req.ip}. Endpoint: ${req.originalUrl}. Paywise successfully neutralized the threat.`,
                        status: 'error'
                    });

                    return res.status(403).json({ msg: 'Paywise Security: Malicious payload blocked. This incident has been logged and reported to the Administrator.' });
                }
            }
        }
    } catch (e) {
        console.error('Cyber defense error:', e);
    }
    next();
};

module.exports = cyberDefense;
