const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
    // 1. Create a transporter
    // For testing/demostration purposes without real credentials we can mock this, 
    // but here we setup a generic SMTP config that the user can plug their credentials into.
    const transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    // 2. Define the email options
    const mailOptions = {
        from: `Paywise App <${process.env.EMAIL_USER || 'noreply@paywise.app'}>`,
        to: options.email,
        subject: options.subject,
        text: options.message,
    };

    // 3. Actually send the email
    // If EMAIL_USER is not set, we'll just console log it to prevent crashing locally if not configured yet.
    if (!process.env.EMAIL_USER) {
        console.log('----------------------------------------------------');
        console.log('EMAIL SIMULATION (Nodemailer not configured in .env):');
        console.log('To:', options.email);
        console.log('Subject:', options.subject);
        console.log('Message:', options.message);
        console.log('----------------------------------------------------');
        return;
    }

    await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;
