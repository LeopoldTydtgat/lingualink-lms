import { Resend } from 'resend'

// Single shared Resend instance used across the whole app
const resend = new Resend(process.env.RESEND_API_KEY)

export default resend