export const subjects = [
  {
    type: 'http://rdf.myexperiment.org/ontologies/base/Submission',
    path: `
      ?subject
        pav:createdBy ?organisation ;
        pav:providedBy ?vendor .
    `,
  },
];
