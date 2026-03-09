/**
 * Oracle Cloud Infrastructure (OCI) Object Storage utility
 * Handles uploading images to OCI buckets for:
 *  - Profile pictures
 *  - Group avatars
 *  - Bill/receipt images (linked to expenses)
 */
const objectStorage = require('oci-objectstorage');
const common = require('oci-common');
const path = require('path');

// Build the OCI auth provider from env vars (no wallet file needed)
function getProvider() {
    const rawKey = process.env.OCI_PRIVATE_KEY_CONTENTS;
    if (!rawKey) {
        throw new Error('OCI_PRIVATE_KEY_CONTENTS is not set in .env');
    }

    // Handle both real newlines and escaped \n, and trim any whitespace/quotes
    const privateKeyContent = rawKey
        .trim()
        .replace(/^["']|["']$/g, '') // Remove wrapping quotes if they exist
        .replace(/\\n/g, '\n')       // Convert literal \n to real newlines
        .replace(/\\r/g, '');        // Remove literal \r if present


    return new common.SimpleAuthenticationDetailsProvider(
        process.env.OCI_TENANCY_OCID,
        process.env.OCI_USER_OCID,
        process.env.OCI_FINGERPRINT,
        privateKeyContent,
        null, // passphrase (none)
        common.Region.fromRegionId(process.env.OCI_REGION || 'us-ashburn-1')
    );
}

function getClient() {
    const provider = getProvider();
    return new objectStorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
}

const NAMESPACE = process.env.OCI_NAMESPACE;
const BUCKET    = process.env.OCI_BUCKET_NAME;
const REGION    = process.env.OCI_REGION || 'us-ashburn-1';

/**
 * Upload a buffer to OCI Object Storage
 * @param {Buffer} buffer - File buffer
 * @param {string} objectName - Path/name in bucket, e.g. "profiles/userId.jpg"
 * @param {string} contentType - MIME type, e.g. "image/jpeg"
 * @returns {string} - Public URL of the uploaded object
 */
async function uploadToOCI(buffer, objectName, contentType = 'image/jpeg') {
    const client = getClient();

    const request = {
        namespaceName: NAMESPACE,
        bucketName: BUCKET,
        objectName,
        contentLength: buffer.length,
        putObjectBody: buffer,
        contentType,
    };

    await client.putObject(request);

    // Construct the public URL
    // OCI Object Storage public URL format:
    // https://objectstorage.<region>.oraclecloud.com/n/<namespace>/b/<bucket>/o/<objectName>
    const encodedName = encodeURIComponent(objectName).replace(/%2F/g, '/');
    const url = `https://objectstorage.${REGION}.oraclecloud.com/n/${NAMESPACE}/b/${BUCKET}/o/${encodedName}`;
    return url;
}

/**
 * Delete an object from OCI Object Storage
 * @param {string} objectName - Object path in bucket
 */
async function deleteFromOCI(objectName) {
    try {
        const client = getClient();
        await client.deleteObject({
            namespaceName: NAMESPACE,
            bucketName: BUCKET,
            objectName,
        });
    } catch (err) {
        // Non-fatal – object may not exist
        console.warn('[OCI] Failed to delete object:', objectName, err.message);
    }
}

/**
 * Extract the object name from a full OCI URL
 * @param {string} url
 * @returns {string|null}
 */
function objectNameFromUrl(url) {
    if (!url || !url.includes('/o/')) return null;
    return decodeURIComponent(url.split('/o/')[1]);
}

module.exports = { uploadToOCI, deleteFromOCI, objectNameFromUrl };
