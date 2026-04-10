/**
 * @file User.js
 * @description Mongoose User model — minimal fields only.
 */
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
    {
        username: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            minlength: 2,
            maxlength: 20,
        },
        password: {
            type: String,
            required: true,
        },
        rating: {
            type: Number,
            default: 1000,
        },
    },
    { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
