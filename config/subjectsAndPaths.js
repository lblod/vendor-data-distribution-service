export const subjects = [
  {
    type: 'http://rdf.myexperiment.org/ontologies/base/Submission',
    trigger: `
      ?subject a <http://rdf.myexperiment.org/ontologies/base/Submission> .
    `,
    path: `
      ?subject
        pav:createdBy ?organisation ;
        pav:providedBy ?vendor .
    `,
    remove: {
      delete: `
        ?subject ?p ?o .
      `,
      where: `
        ?subject ?p ?o .
      `,
    },
    copy: {
      insert: `
        ?subject ?p ?o .
      `,
      where: `
        ?subject ?p ?o .
      `,
    },
  },
];
