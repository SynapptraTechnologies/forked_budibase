const jwt = require("jsonwebtoken")
const CouchDB = require("../../db")
const bcrypt = require("../../utilities/bcrypt")
const env = require("../../environment")
const { getAPIKey } = require("../../utilities/usageQuota")
const { generateUserMetadataID } = require("../../db/utils")
const { setCookie } = require("../../utilities")
const { outputProcessing } = require("../../utilities/rowProcessor")
const { InternalTables } = require("../../db/utils")
const { UserStatus, StaticDatabases } = require("@budibase/auth")
const { getFullUser } = require("../../utilities/users")

const INVALID_ERR = "Invalid Credentials"

exports.authenticate = async ctx => {
  const appId = ctx.appId
  if (!appId) ctx.throw(400, "No appId")

  const { email, password } = ctx.request.body

  if (!email) ctx.throw(400, "Email Required.")
  if (!password) ctx.throw(400, "Password Required.")

  // Check the user exists in the instance DB by email
  const db = new CouchDB(appId)
  const app = await db.get(appId)

  let dbUser
  try {
    dbUser = await db.get(generateUserMetadataID(email))
  } catch (_) {
    // do not want to throw a 404 - as this could be
    // used to determine valid emails
    ctx.throw(401, INVALID_ERR)
  }

  // check that the user is currently inactive, if this is the case throw invalid
  if (dbUser.status === UserStatus.INACTIVE) {
    ctx.throw(401, INVALID_ERR)
  }

  // authenticate
  if (await bcrypt.compare(password, dbUser.password)) {
    const payload = {
      userId: dbUser._id,
      roleId: dbUser.roleId,
      version: app.version,
    }
    // if in prod add the user api key, unless self hosted
    /* istanbul ignore next */
    if (env.isProd() && !env.SELF_HOSTED) {
      const { apiKey } = await getAPIKey(ctx.appId)
      payload.apiKey = apiKey
    }

    const token = jwt.sign(payload, ctx.config.jwtSecret, {
      expiresIn: "1 day",
    })

    setCookie(ctx, token, appId)

    delete dbUser.password
    ctx.body = {
      token,
      ...dbUser,
      appId,
    }
  } else {
    ctx.throw(401, INVALID_ERR)
  }
}

exports.fetchSelf = async ctx => {
  const appId = ctx.appId
  const { userId } = ctx.user
  /* istanbul ignore next */
  if (!userId) {
    ctx.body = {}
    return
  }

  if (!appId) {
    const db = new CouchDB(StaticDatabases.USER.name)
    const user = await db.get(userId)
    delete user.password
    ctx.body = { user }
    return
  }

  const db = new CouchDB(appId)
  const user = await getFullUser({ ctx, userId: userId })
  const userTable = await db.get(InternalTables.USER_METADATA)
  if (user) {
    delete user.password
  }
  // specifically needs to make sure is enriched
  ctx.body = await outputProcessing(appId, userTable, user)
}
