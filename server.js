require('dotenv').config();

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const { google } = require('googleapis');

const {
    loadDatabase,
    saveDatabase
} = require('./database');

const app = express();

app.set("trust proxy", 1);
const PORT =
    process.env.PORT || 3001;

const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    'http://localhost:3000';


// =====================================================
// DATABASE
// =====================================================

let database = loadDatabase();


// =====================================================
// APP SETTINGS
// =====================================================

app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true
}));

app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'none',
        secure: true,
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));


// =====================================================
// GOOGLE OAUTH
// =====================================================

const oauth2Client =
    new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.REDIRECT_URI
    );


// =====================================================
// GOOGLE CLASSROOM PERMISSIONS
// =====================================================

const SCOPES = [

    'openid',
    'email',
    'profile',

    'https://www.googleapis.com/auth/classroom.courses.readonly',

    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',

    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',

    'https://www.googleapis.com/auth/classroom.coursework.students.readonly',

    'https://www.googleapis.com/auth/classroom.rosters.readonly'

];


// =====================================================
// AUTHENTICATED CLIENT
// =====================================================

function getAuthedClient(req) {

    if (!req.session.tokens) {
        return null;
    }

    const client =
        new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.REDIRECT_URI
        );

    client.setCredentials(
        req.session.tokens
    );

    return client;
}


// =====================================================
// REQUIRE LOGIN
// =====================================================

function requireLogin(req, res, next) {

    if (!req.session.tokens) {

        return res.status(401).json({
            error: 'not_connected'
        });

    }

    next();
}


// =====================================================
// HOME
// =====================================================

app.get('/', (req, res) => {

    res.send(
        'AtomScape Classroom backend is running.'
    );

});


// =====================================================
// GOOGLE LOGIN
// =====================================================

app.get('/auth/google', (req, res) => {

    const url =
        oauth2Client.generateAuthUrl({

            access_type: 'offline',

            prompt: 'consent',

            scope: SCOPES

        });

    res.redirect(url);

});


// =====================================================
// GOOGLE CALLBACK
// =====================================================

app.get(
    '/auth/google/callback',
    async (req, res) => {

        const {
            code,
            error
        } = req.query;

        if (error) {

            return res.status(400).send(
                'Google returned an error: ' +
                error
            );

        }

        if (!code) {

            return res.status(400).send(
                'Missing code.'
            );

        }

        try {

            const {
                tokens
            } =
                await oauth2Client.getToken(code);


            // -------------------------------------------------
            // GOOGLE USER CLIENT
            // -------------------------------------------------

            const userClient =
                new google.auth.OAuth2(
                    process.env.GOOGLE_CLIENT_ID,
                    process.env.GOOGLE_CLIENT_SECRET,
                    process.env.REDIRECT_URI
                );

            userClient.setCredentials(tokens);


            const oauth2 =
                google.oauth2({
                    version: 'v2',
                    auth: userClient
                });


            const {
                data: userInfo
            } =
                await oauth2.userinfo.get();


            // -------------------------------------------------
            // SAVE LOGIN TO SESSION
            // -------------------------------------------------

            req.session.tokens = tokens;

            req.session.googleId =
                userInfo.id;


            // -------------------------------------------------
            // CREATE / UPDATE USER
            // -------------------------------------------------

            const existingUser =
                database.users.find(
                    user =>
                        user.googleId ===
                        userInfo.id
                );


            if (existingUser) {

                existingUser.name =
                    userInfo.name ||
                    existingUser.name;

                existingUser.email =
                    userInfo.email ||
                    existingUser.email;

                existingUser.picture =
                    userInfo.picture ||
                    existingUser.picture;

            } else {

                database.users.push({

                    id:
                        'user_' +
                        Date.now() +
                        '_' +
                        Math.random()
                            .toString(36)
                            .slice(2, 8),

                    googleId:
                        userInfo.id,

                    name:
                        userInfo.name ||
                        'Google User',

                    email:
                        userInfo.email ||
                        '',

                    picture:
                        userInfo.picture ||
                        '',

                    createdAt:
                        new Date().toISOString()

                });

            }


            saveDatabase(database);


            console.log(
                'Google Classroom connected:',
                userInfo.name
            );


            // -------------------------------------------------
            // IMPORTANT:
            // FORCE EXPRESS TO SAVE THE SESSION
            // BEFORE REDIRECTING TO THE FRONTEND
            // -------------------------------------------------

            req.session.save(
                saveError => {

                    if (saveError) {

                        console.error(
                            'SESSION SAVE ERROR:',
                            saveError
                        );

                        return res.status(500).send(
                            'Could not save login session.'
                        );

                    }


                    console.log(
                        'Login session saved successfully.'
                    );


                    res.redirect(
                        FRONTEND_URL +
                        '?connected=1'
                    );

                }
            );


        } catch (err) {

            console.error(
                'OAuth ERROR:',
                err.response?.data ||
                err.message
            );


            res.status(500).send(

                'OAuth failed: ' +

                (
                    err.response?.data
                        ?.error_description ||

                    err.message

                )

            );

        }

    }
);


// =====================================================
// CURRENT USER
// =====================================================

app.get(
    '/api/me',
    requireLogin,
    async (req, res) => {

        try {

            const auth =
                getAuthedClient(req);

            const oauth2 =
                google.oauth2({
                    version: 'v2',
                    auth
                });

            const {
                data
            } =
                await oauth2.userinfo.get();


            res.json({

                id:
                    data.id,

                name:
                    data.name,

                email:
                    data.email,

                picture:
                    data.picture || ''

            });


        } catch (err) {

            console.error(
                'USER INFO ERROR:',
                err.message
            );

            res.status(500).json({

                error:
                    'Could not load user'

            });

        }

    }
);


// =====================================================
// CONNECTION STATUS
// =====================================================

app.get('/api/status', (req, res) => {

    const connected =
        !!req.session.tokens;

    let user = null;


    if (
        connected &&
        req.session.googleId
    ) {

        const databaseUser =
            database.users.find(
                currentUser =>
                    currentUser.googleId ===
                    req.session.googleId
            );


        if (databaseUser) {

            user = {

                id:
                    databaseUser.googleId,

                name:
                    databaseUser.name,

                email:
                    databaseUser.email,

                picture:
                    databaseUser.picture || ''

            };

        }

    }


    res.json({

        connected,

        user

    });

});


// =====================================================
// DISCONNECT
// =====================================================

app.get('/auth/disconnect', (req, res) => {

    req.session.destroy(error => {

        if (error) {

            console.error(
                'SESSION DESTROY ERROR:',
                error
            );

            return res.status(500).json({
                error: 'Could not disconnect'
            });

        }


        res.clearCookie('connect.sid');

        res.json({
            ok: true
        });

    });

});


// =====================================================
// GOOGLE CLASSROOM HELPERS
// =====================================================

async function getStudentCourses(classroom) {

    const courses = [];

    let pageToken;


    do {

        const result =
            await classroom.courses.list({

                studentId: 'me',

                pageSize: 100,

                pageToken

            });


        if (result.data.courses) {

            courses.push(
                ...result.data.courses
            );

        }


        pageToken =
            result.data.nextPageToken;


    } while (pageToken);


    return courses;

}


async function getTeacherCourses(classroom) {

    const courses = [];

    let pageToken;


    do {

        const result =
            await classroom.courses.list({

                teacherId: 'me',

                pageSize: 100,

                pageToken

            });


        if (result.data.courses) {

            courses.push(
                ...result.data.courses
            );

        }


        pageToken =
            result.data.nextPageToken;


    } while (pageToken);


    return courses;

}


// =====================================================
// COURSES
// =====================================================

app.get(
    '/api/courses',
    requireLogin,
    async (req, res) => {

        const auth =
            getAuthedClient(req);


        try {

            const classroom =
                google.classroom({

                    version: 'v1',

                    auth

                });


            let studentCourses = [];

            let teacherCourses = [];


            try {

                studentCourses =
                    await getStudentCourses(
                        classroom
                    );

            } catch (err) {

                console.log(
                    'Student courses unavailable:',
                    err.message
                );

            }


            try {

                teacherCourses =
                    await getTeacherCourses(
                        classroom
                    );

            } catch (err) {

                console.log(
                    'Teacher courses unavailable:',
                    err.message
                );

            }


            res.json({

                studentCourses,

                teacherCourses

            });


        } catch (err) {

            console.error(
                'COURSES ERROR:',
                err.message
            );


            res.status(500).json({

                error:
                    err.message

            });

        }

    }
);


// =====================================================
// STUDENT COURSEWORK
// =====================================================

app.get(
    '/api/student-coursework',
    requireLogin,
    async (req, res) => {

        try {

            const classroom =
                google.classroom({

                    version: 'v1',

                    auth:
                        getAuthedClient(req)

                });


            const courses =
                await getStudentCourses(
                    classroom
                );


            const allWork = [];


            for (const course of courses) {

                try {

                    const result =
                        await classroom
                            .courses
                            .courseWork
                            .list({

                                courseId:
                                    course.id,

                                courseWorkStates:
                                    ['PUBLISHED'],

                                pageSize: 100

                            });


                    const work =
                        result.data.courseWork ||
                        [];


                    for (
                        const item of work
                    ) {

                        let submissionState =
                            'UNKNOWN';


                        try {

                            const submission =
                                await classroom
                                    .courses
                                    .courseWork
                                    .studentSubmissions
                                    .list({

                                        courseId:
                                            course.id,

                                        courseWorkId:
                                            item.id,

                                        userId:
                                            'me'

                                    });


                            const submissions =
                                submission.data
                                    .studentSubmissions ||
                                [];


                            if (
                                submissions.length
                            ) {

                                submissionState =
                                    submissions[0].state ||
                                    'UNKNOWN';

                            }

                        } catch (err) {

                            console.log(
                                'Submission error:',
                                err.message
                            );

                        }


                        allWork.push({

                            id:
                                item.id,

                            courseId:
                                course.id,

                            courseName:
                                course.name,

                            title:
                                item.title,

                            points:
                                item.maxPoints ||
                                0,

                            dueDate:
                                item.dueDate ||
                                null,

                            dueTime:
                                item.dueTime ||
                                null,

                            alternateLink:
                                item.alternateLink ||
                                null,

                            submissionState

                        });

                    }

                } catch (err) {

                    console.log(
                        'Student coursework error:',
                        err.message
                    );

                }

            }


            res.json(allWork);


        } catch (err) {

            console.error(
                'STUDENT COURSEWORK ERROR:',
                err.message
            );


            res.status(500).json({

                error:
                    err.message

            });

        }

    }
);


// =====================================================
// TEACHER COURSEWORK
// =====================================================

app.get(
    '/api/teacher-coursework',
    requireLogin,
    async (req, res) => {

        try {

            const classroom =
                google.classroom({

                    version: 'v1',

                    auth:
                        getAuthedClient(req)

                });


            const courses =
                await getTeacherCourses(
                    classroom
                );


            const allWork = [];


            for (const course of courses) {

                try {

                    const result =
                        await classroom
                            .courses
                            .courseWork
                            .list({

                                courseId:
                                    course.id,

                                pageSize: 100

                            });


                    const work =
                        result.data.courseWork ||
                        [];


                    for (
                        const item of work
                    ) {

                        allWork.push({

                            id:
                                item.id,

                            courseId:
                                course.id,

                            courseName:
                                course.name,

                            title:
                                item.title,

                            description:
                                item.description ||
                                '',

                            points:
                                item.maxPoints ||
                                0,

                            dueDate:
                                item.dueDate ||
                                null,

                            dueTime:
                                item.dueTime ||
                                null,

                            alternateLink:
                                item.alternateLink ||
                                null,

                            state:
                                item.state ||
                                'UNKNOWN'

                        });

                    }

                } catch (err) {

                    console.log(
                        'Teacher coursework error:',
                        err.message
                    );

                }

            }


            res.json(allWork);


        } catch (err) {

            console.error(
                'TEACHER COURSEWORK ERROR:',
                err.message
            );


            res.status(500).json({

                error:
                    err.message

            });

        }

    }
);


// =====================================================
// STUDY GROUP HELPERS
// =====================================================

function getCurrentUser(req) {

    const googleId =
        req.session.googleId;


    if (!googleId) {
        return null;
    }


    return database.users.find(
        user =>
            user.googleId === googleId
    ) || null;

}


function getGroup(groupId) {

    return database.groups.find(
        group =>
            group.id === groupId
    ) || null;

}


function isMember(group, userId) {

    return group.members.includes(
        userId
    );

}


// =====================================================
// STUDY GROUPS
// =====================================================

app.get(
    '/api/study-groups',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        if (!user) {

            return res.status(401).json({

                error:
                    'User profile not found. Please reconnect Google.'

            });

        }


        const groups =
            database.groups.filter(
                group =>
                    group.members.includes(
                        user.id
                    )
            );


        res.json(groups);

    }
);


// =====================================================
// CREATE GROUP
// =====================================================

app.post(
    '/api/study-groups',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        if (!user) {

            return res.status(401).json({

                error:
                    'User profile not found.'

            });

        }


        const name =
            String(
                req.body.name || ''
            ).trim();


        const description =
            String(
                req.body.description || ''
            ).trim();


        if (!name) {

            return res.status(400).json({

                error:
                    'Group name is required.'

            });

        }


        if (name.length > 80) {

            return res.status(400).json({

                error:
                    'Group name is too long.'

            });

        }


        const group = {

            id:
                'group_' +
                Date.now() +
                '_' +
                Math.random()
                    .toString(36)
                    .slice(2, 8),

            name,

            description,

            creatorId:
                user.id,

            members: [
                user.id
            ],

            createdAt:
                new Date().toISOString()

        };


        database.groups.push(
            group
        );


        saveDatabase(database);


        res.status(201).json(
            group
        );

    }
);


// =====================================================
// JOIN GROUP
// =====================================================

app.post(
    '/api/study-groups/:groupId/join',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        const group =
            getGroup(
                req.params.groupId
            );


        if (!user) {

            return res.status(401).json({
                error: 'User not found.'
            });

        }


        if (!group) {

            return res.status(404).json({
                error: 'Group not found.'
            });

        }


        if (
            !group.members.includes(
                user.id
            )
        ) {

            group.members.push(
                user.id
            );

            saveDatabase(database);

        }


        res.json(group);

    }
);


// =====================================================
// LEAVE GROUP
// =====================================================

app.post(
    '/api/study-groups/:groupId/leave',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        const group =
            getGroup(
                req.params.groupId
            );


        if (!user || !group) {

            return res.status(404).json({

                error:
                    'Group not found.'

            });

        }


        if (
            group.creatorId ===
            user.id
        ) {

            return res.status(400).json({

                error:
                    'The group creator cannot leave the group.'

            });

        }


        group.members =
            group.members.filter(
                id =>
                    id !== user.id
            );


        saveDatabase(database);


        res.json({
            ok: true
        });

    }
);


// =====================================================
// GROUP DETAILS
// =====================================================

app.get(
    '/api/study-groups/:groupId',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        const group =
            getGroup(
                req.params.groupId
            );


        if (!user || !group) {

            return res.status(404).json({

                error:
                    'Group not found.'

            });

        }


        if (
            !isMember(
                group,
                user.id
            )
        ) {

            return res.status(403).json({

                error:
                    'You are not a member of this group.'

            });

        }


        const members =
            group.members.map(
                memberId => {

                    const member =
                        database.users.find(
                            user =>
                                user.id ===
                                memberId
                        );


                    if (!member) {
                        return null;
                    }


                    return {

                        id:
                            member.id,

                        name:
                            member.name,

                        picture:
                            member.picture

                    };

                }
            ).filter(Boolean);


        res.json({

            ...group,

            members

        });

    }
);


// =====================================================
// GET MESSAGES
// =====================================================

app.get(
    '/api/study-groups/:groupId/messages',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        const group =
            getGroup(
                req.params.groupId
            );


        if (!user || !group) {

            return res.status(404).json({

                error:
                    'Group not found.'

            });

        }


        if (
            !isMember(
                group,
                user.id
            )
        ) {

            return res.status(403).json({

                error:
                    'You are not a member of this group.'

            });

        }


        const messages =
            database.messages
                .filter(
                    message =>
                        message.groupId ===
                        group.id
                )
                .slice(-100)
                .map(message => ({
                    ...message,

                    isOwner:
                        message.userId ===
                        user.id
                }));


        res.json(messages);

    }
);


// =====================================================
// SEND MESSAGE
// =====================================================

app.post(
    '/api/study-groups/:groupId/messages',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        const group =
            getGroup(
                req.params.groupId
            );


        if (!user || !group) {

            return res.status(404).json({

                error:
                    'Group not found.'

            });

        }


        if (
            !isMember(
                group,
                user.id
            )
        ) {

            return res.status(403).json({

                error:
                    'You are not a member of this group.'

            });

        }


        const text =
            String(
                req.body.text || ''
            ).trim();


        if (!text) {

            return res.status(400).json({

                error:
                    'Message cannot be empty.'

            });

        }


        if (text.length > 1000) {

            return res.status(400).json({

                error:
                    'Message is too long.'

            });

        }


        const message = {

            id:
                'message_' +
                Date.now() +
                '_' +
                Math.random()
                    .toString(36)
                    .slice(2, 8),

            groupId:
                group.id,

            userId:
                user.id,

            userName:
                user.name,

            userPicture:
                user.picture || '',

            text,

            createdAt:
                new Date().toISOString()

        };


        database.messages.push(
            message
        );


        if (
            database.messages.length >
            10000
        ) {

            database.messages =
                database.messages.slice(
                    -10000
                );

        }


        saveDatabase(database);


        res.status(201).json(
            message
        );

    }
);


// =====================================================
// DELETE MESSAGE
// =====================================================

app.delete(
    '/api/study-groups/:groupId/messages/:messageId',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        const group =
            getGroup(
                req.params.groupId
            );


        if (!user || !group) {

            return res.status(404).json({

                error:
                    'Group not found.'

            });

        }


        if (
            !isMember(
                group,
                user.id
            )
        ) {

            return res.status(403).json({

                error:
                    'Not a group member.'

            });

        }


        const message =
            database.messages.find(
                message =>
                    message.id ===
                    req.params.messageId
            );


        if (!message) {

            return res.status(404).json({

                error:
                    'Message not found.'

            });

        }


        if (
            message.userId !==
            user.id
        ) {

            return res.status(403).json({

                error:
                    'You can only delete your own messages.'

            });

        }


        database.messages =
            database.messages.filter(
                message =>
                    message.id !==
                    req.params.messageId
            );


        saveDatabase(database);


        res.json({
            ok: true
        });

    }
);


// =====================================================
// REPORT MESSAGE
// =====================================================

app.post(
    '/api/study-groups/:groupId/messages/:messageId/report',
    requireLogin,
    (req, res) => {

        const user =
            getCurrentUser(req);


        const group =
            getGroup(
                req.params.groupId
            );


        if (!user || !group) {

            return res.status(404).json({

                error:
                    'Group not found.'

            });

        }


        if (
            !isMember(
                group,
                user.id
            )
        ) {

            return res.status(403).json({

                error:
                    'Not a group member.'

            });

        }


        const message =
            database.messages.find(
                message =>
                    message.id ===
                    req.params.messageId
            );


        if (!message) {

            return res.status(404).json({

                error:
                    'Message not found.'

            });

        }


        if (!database.reports) {
            database.reports = [];
        }


        database.reports.push({

            id:
                'report_' +
                Date.now(),

            messageId:
                message.id,

            groupId:
                group.id,

            reporterId:
                user.id,

            reason:
                String(
                    req.body.reason ||
                    'Reported by group member'
                ).slice(0, 500),

            createdAt:
                new Date().toISOString()

        });


        saveDatabase(database);


        res.json({

            ok: true,

            message:
                'Message reported.'

        });

    }
);


// =====================================================
// START SERVER
// =====================================================

app.listen(
    PORT,
    () => {

        console.log(
            `AtomScape Classroom backend listening on port ${PORT}`
        );

    }
);
