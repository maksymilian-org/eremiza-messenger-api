import nodemailer from "nodemailer";

export async function mail(title, content, attachments) {
  // create reusable transporter object using the default SMTP transport
  let transporter = nodemailer.createTransport({
    host: `${process.env.EMAIL_HOST}`,
    port: `${process.env.EMAIL_PORT}`,
    secure: true, // true for 465, false for other ports
    auth: {
      user: `${process.env.EMAIL_FROM}`, // generated ethereal user
      pass: `${process.env.EMAIL_PASSWORD}`, // generated ethereal password
    },
  });

  // send mail with defined transport object
  let info = await transporter.sendMail({
    from: `${process.env.EMAIL_FROM_NAME} <${process.env.EMAIL_FROM}>`, // sender address
    to: `${process.env.EMAIL_TO}`, // list of receivers
    subject: title, // Subject line
    text: content, // plain text body
    html: content, // html body
    attachments,
  });

  console.log("Message sent: %s", info.messageId);
  // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>
}
