"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateJsonSchema = validateJsonSchema;
function isCanonicalDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day);
}
function validateJsonSchema(schema, value, path = "input") {
    if (schema.type === "object") {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return [`${path} must be an object.`];
        const object = value;
        const errors = [];
        for (const key of schema.required || []) {
            if (!(key in object))
                errors.push(`${path}.${key} is required.`);
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(object)) {
                if (!(key in schema.properties))
                    errors.push(`${path}.${key} is not allowed.`);
            }
        }
        for (const [key, child] of Object.entries(schema.properties)) {
            if (key in object)
                errors.push(...validateJsonSchema(child, object[key], `${path}.${key}`));
        }
        return errors;
    }
    if (schema.type === "array") {
        if (!Array.isArray(value))
            return [`${path} must be an array.`];
        const errors = [];
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            errors.push(`${path} must contain at least ${schema.minItems} item(s).`);
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            errors.push(`${path} must contain at most ${schema.maxItems} item(s).`);
        }
        value.forEach((item, index) => errors.push(...validateJsonSchema(schema.items, item, `${path}[${index}]`)));
        return errors;
    }
    if (schema.type === "string") {
        if (typeof value !== "string")
            return [`${path} must be a string.`];
        const errors = [];
        if (schema.enum && !schema.enum.includes(value))
            errors.push(`${path} must be one of: ${schema.enum.join(", ")}.`);
        if (schema.format === "date" && !isCanonicalDate(value))
            errors.push(`${path} must be YYYY-MM-DD.`);
        if (schema.minLength !== undefined && value.length < schema.minLength)
            errors.push(`${path} is too short.`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength)
            errors.push(`${path} is too long.`);
        return errors;
    }
    if (schema.type === "boolean")
        return typeof value === "boolean" ? [] : [`${path} must be a boolean.`];
    if (typeof value !== "number" || !Number.isFinite(value))
        return [`${path} must be a number.`];
    if (schema.type === "integer" && !Number.isInteger(value))
        return [`${path} must be an integer.`];
    const errors = [];
    if (schema.minimum !== undefined && value < schema.minimum)
        errors.push(`${path} must be >= ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum)
        errors.push(`${path} must be <= ${schema.maximum}.`);
    return errors;
}
