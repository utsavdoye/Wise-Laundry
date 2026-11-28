import mongoose from 'mongoose'

// One pending login code per email. The newest request overwrites the old one.
const emailLoginCodeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    tries: { type: Number, default: 0 },
    resendAvailableAt: { type: Date, required: true },
  },
  { timestamps: true },
)

// Let the database drop codes on its own once they expire.
emailLoginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const EmailLoginCode = mongoose.model('EmailLoginCode', emailLoginCodeSchema)
