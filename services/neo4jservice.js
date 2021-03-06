"use strict";

const Q = require('q');
const co = require('co');
const es = require('event-stream');
const duniter = require('duniter');
const neo4j = require('neo4j-driver').v1;
const ws = require('ws');

module.exports = (duniterServer, neo4jHost, neo4jPort) => {
    return new Neo4jService(duniterServer, neo4jHost, neo4jPort);
};

function Neo4jService(duniterServer, neo4jHost, neo4jPort) {

    const that = this;
    let db;

    this.getShorteningPath = (uid) => co(function*() {
        const session = that.db.session();
        try {
           const result = yield session.run({text:`MATCH p=( (n { uid:{uid}} ) <-[*2]- (f2f) )
WHERE NOT (n) --> (f2f) AND n <> f2f
RETURN f2f.uid, count(p), collect([ x in nodes(p)[1..-1] | x.uid])
ORDER BY count(p) DESC`,
               parameters: {uid: uid}});
            const shorteningPaths = [];
            for(const r of result.records) {
                const certifiers = [];
                for (const cert of r._fields[2]) {
                    certifiers.add(cert[0]);
                }
                shorteningPaths.add({
                    'f2f': r._fields[0],
                    'certifiers': certifiers,
                });
            }
            return shorteningPaths;
        } catch (e) {
            console.log(e);
        } finally {
            // Completed!
            session.close();
        }
        return []
    });

    this.getSentriesPaths = (uid) => co(function*() {
        const session = that.db.session();
        try {
           //const result = yield session.run({text:`MATCH (n { uid:{uid}} ) RETURN n.uid, n.created_on` ,
           //    parameters: {uid: uid}});

	   const result = yield session.run({text:
			"MATCH p=allShortestPaths((n {uid : {uid}}) -[*]-> (sentry {sentry : 1}))\n\
			RETURN sentry.uid,count(p),length(p),collect([ x in nodes(p)[1..-1] | x.uid])\n\
			ORDER BY count(p) DESC",
               parameters: {uid: uid}});

		// MATCH p=allShortestPaths((n {uid : "inso"}) -[*]-> (sentry {sentry : 1}))
		// RETURN sentry.uid,count(p),length(p),collect([ x in nodes(p)[1..-1] | x.uid])
		// ORDER BY length(p) DESC


	    const sentriesPaths = [];
            for(const r of result.records) {

                const paths = [];
                for (const path of r._fields[3]) {
                    paths.add(path[0]);
                }
		
                sentriesPaths.add({
                    'sentry': r._fields[0],
		    'count': r._fields[1].getLowBits(),
                    'length': r._fields[2].getLowBits(),
		    'paths': r._fields[3]
                })
            }
            return sentriesPaths;
        } catch (e) {
            console.log(e);
        } finally {
            // Completed!
            session.close();
        }
        return []
    });

    this.refreshWoT = () => co(function*() {
        const session = that.db.session();
        try {
            yield session.run("MATCH (n) DETACH\nDELETE n");
            console.log("Select identities");
            const identities = yield duniterServer.dal.idtyDAL.query('SELECT `pub`, `uid`,`member`,`created_on`,`written_on` FROM i_index;');
            console.log(identities);

	    // Get members count
	    const head = yield duniterServer.dal.getCurrentBlockOrNull();
	    const membersCount = head ? head.membersCount : 0;

	    // Calculate cert number required to become sentry
	    let dSen;
	    dSen = Math.ceil(Math.pow(membersCount, 1 / duniterServer.conf.stepMax));

            for(const idty in identities) {
                yield session.run({
                    text: "CREATE (n:Idty { pubkey: {pubkey}, uid: {uid}, member: {member}, created_on: {created_on}, written_on: {written_on}, sentry: {sentry} })",
                    parameters: {
                        pubkey: identities[idty].pub,
                        uid: identities[idty].uid,
                        member: identities[idty].member,
			created_on: identities[idty].created_on.split("-",1),
			written_on: identities[idty].written_on.split("-",1),
			sentry: "0"
                    }
                });
           }
            const certs = yield duniterServer.dal.certDAL.query('SELECT `issuer`,`receiver`,`created_on`,`written_on` FROM c_index;');
            console.log(certs);
            for(const c in certs) {
                yield session.run({text:"MATCH (u:Idty { pubkey:{issuer} }), (r:Idty { pubkey:{receiver} })\n\
    				CREATE (u)-[c:CERTIFY { created_on: {created_on}, written_on: {written_on} } ]->(r)",
                        parameters:{
                            issuer: certs[c].issuer,
                            receiver: certs[c].receiver,
			    created_on: certs[c].created_on.split("-",1),
			    written_on: certs[c].written_on.split("-",1)
                        }
                });
            }
            console.log("Done");

	    // Mark sentries in Neo4j database
	    // MATCH (i) --> (sentry)
	    // WITH sentry, count(i) as count_i
	    // WHERE count_i > 3
	    // MATCH (sentry) --> (r)
	    // WITH sentry, count(r) as count_r, count_i
	    // WHERE count_r > 3
	    // RETURN sentry.uid, count_r, count_i

            yield session.run({
                text: "MATCH (i) --> (sentry)\n\
			WITH sentry, count(i) as count_i\n\
			WHERE count_i >= {dSen}\n\
			MATCH (sentry) --> (r)\n\
			WITH sentry, count(r) as count_r, count_i\n\
			WHERE count_r >= {dSen}\n\
			SET sentry.sentry = 1",
                    parameters: {
                        dSen: dSen
                 }
             });

        } catch (e) {
            console.log(e);
        } finally {
            // Completed!
            session.close();
        }

    });

    this.init = () => co(function*() {
        try {
            that.db = neo4j.driver("bolt://" + neo4jHost,
                neo4j.auth.basic(duniterServer.conf.neo4j.user, duniterServer.conf.neo4j.password));

            yield that.refreshWoT();
            that.db.onError = (error) => {
                console.log(error);
            };
            duniterServer
                .pipe(es.mapSync((data) => co(function*(){
                    try {
                        // Broadcast block
                        if (data.joiners) {
                            yield that.refreshWoT();
                        }
                    } catch (e) {
                        console.log(e);
                    }
                }))
                );

        } catch (e) {
            console.log(e);
        }

    });
}
