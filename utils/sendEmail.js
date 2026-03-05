const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
    // 1. Create a transporter for Zoho Mail
    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.zoho.com',
        port: process.env.EMAIL_PORT || 465,
        secure: true, // true for 465, false for other ports
        auth: {
            user: process.env.EMAIL_USER || 'no.reply@paywiseapp.com',
            pass: process.env.EMAIL_PASS
        }
    });

    // 2. Define the email options
    const mailOptions = {
        from: `Paywise App <${process.env.EMAIL_USER || 'no.reply@paywiseapp.com'}>`,
        to: options.email,
        subject: options.subject,
        text: options.message,
    };

    // 3. Actually send the email
    // If EMAIL_PASS is not set, we'll just console log it to prevent crashing locally if not configured yet.
    if (!process.env.EMAIL_PASS) {
        console.log('----------------------------------------------------');
        console.log('EMAIL SIMULATION (Nodemailer not configured in .env):');
        console.log('To:', options.email);
        console.log('From:', mailOptions.from);
        console.log('Subject:', options.subject);
        console.log('Message:', options.message);
        console.log('----------------------------------------------------');
        return;
    }

    await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;
